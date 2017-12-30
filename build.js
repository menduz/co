#!/usr/bin/env TSC_NONPOLLING_WATCHER=1 node

// Usage: build.js [-w [-clean]]
//        build.js -O [-nominify]
//  -w         Watch sources for changes and rebuild incrementally
//  -clean     Force rebuilding of everything, ignoring cache. Implied with -O.
//  -O         Generate optimized product
//  -nominify  Do not minify (or mangle) optimized product code (i/c/w -O)
//  -h, -help  Print this help message to stderr and exit
//

// Limitations:
//
//  - uglify-es currently doesn't handle array destructors during optimization.
//    e.g. `let x = 1, y = 1; [x, y] = foo()` generates invalid code because of
//    a bug in the constant-evaluation code, yielding `[1, 1] = foo()`
//

const UglifyJS = require('uglify-es')
const rollup = require('rollup')
const typescriptPlugin = require('rollup-plugin-typescript2')
const fs = require('fs')
const Path = require('path')
const subprocess = require('child_process')
const { join: pjoin, relative: relpath, dirname } = Path
const pkg = require('./package.json')
const promisify = require('util').promisify
const readfile = promisify(fs.readFile)
const writefile = promisify(fs.writeFile)
const rootdir = __dirname

// config
const productName = 'xlang'
const outdir = pjoin(rootdir, 'out')
const srcdir = pjoin(rootdir, 'src')

const debug = !process.argv.includes('-O')
const watch = process.argv.includes('-w')
const minify = !process.argv.includes('-nominify')
const clean = process.argv.includes('-clean')
const outfilename = debug ? `${productName}.debug.js` : `${productName}.js`
const outfile = pjoin(outdir, outfilename)
const mapfile = outfile + '.map'

if (process.argv.includes('-h') || process.argv.includes('-help')) {
  // show usage, read from comment at top of file
  let lines = fs.readFileSync(__filename, 'utf8').split(/\n/, 100)
  let started = false, end = 0, usage = []
  for (let i = 1; i < lines.length; ++i) {
    let line = lines[i]
    if (started) {
      if (!line.startsWith('//')) {
        console.error(usage.join('\n').replace(/[\r\t\n\s]+$/, ''))
        break
      }
      usage.push(line.substr(3))
    } else if (line.startsWith('// Usage:')) {
      started = true
      usage.push(line.substr(3))
    }
  }
  process.exit(1)
} else if (watch && !debug) {
  console.error("error: both -O and -w provided -- confused. Try -h for help")
  process.exit(1)
} else if (!debug && clean) {
  console.warn("warning: -clean has no effect in combination with -O")
}

// constant definitions that may be inlined
const defines_inline = {
  DEBUG: debug,
}

// constant defintions (will be available as `const name = value` at runtime)
const defines_all = Object.assign({
  VERSION: `${pkg.version}-${debug ? 'debug' : getGitHashSync() || 'release'}`,
}, defines_inline)

// typescript config
const tsconfig = {
  // check: false, // don't lint -- faster
  verbosity: 1, // 0 Error, 1 Warning, 2 Info, 3 Debug
  tsconfig: pjoin(rootdir, 'tsconfig.json'),
  tsconfigOverride: {
    compilerOptions: Object.assign({
      // for both debug and release builds
      removeComments: true,
    }, debug ? {
      // only for debug builds
    } : {
      // only for release builds
      noFallthroughCasesInSwitch: true,
      noImplicitAny: true,
      noImplicitReturns: true,
      noImplicitThis: true,
      noUnusedLocals: true,
      // noUnusedParameters: true,
      preserveConstEnums: true,
      strictNullChecks: true,
    })
  },
  cacheRoot: debug ? pjoin(outdir, '.tscache') : undefined,
  clean: clean,
}

// input config
const rin = {
  input: pjoin(srcdir, 'main.ts'),
  external: [
    'fs', 'path',
    'source-map-support',
  ],
  plugins: [
    typescriptPlugin(tsconfig),
  ],
  onwarn(warning) {
    console.warn('WARN', warning.message)
  },
}

// output config
const rout = {
  file: outfile,
  format: 'cjs', // change to umd when we no longer require 'fs'
  name: 'xlang',
  sourcemap: true,
  freeze: debug, // Object.freeze(x) on import * as x from ...
  banner: `/* ${pkg.name} ${defines_all.VERSION} */\n`,
  intro: '',
}

// add predefined constants to intro
rout.intro += 'var ' + Object.keys(defines_all).map(k =>
  k + ' = ' + JSON.stringify(defines_all[k])
).join(', ') + ';\n'

// add global code to intro
rout.intro += getGlobalJSSync()


if (watch) {
  buildIncrementally()
} else {
  buildOnce()
}


function buildIncrementally() {
  const wopt = Object.assign({}, rin, {
    clearScreen: true,
    output: rout,
  })
  rollup.watch(wopt).on('event', ev => {
    switch (ev.code) {
      case 'START':        // the watcher is (re)starting
        break
      case 'BUNDLE_START': // building an individual bundle
        const outfiles = ev.output.map(fn => relpath(rootdir, fn)).join(', ')
        console.log(`build ${outfiles} ...`)
        break
      case 'BUNDLE_END':   // finished building a bundle
        reportBuilt(
          ev.duration,
          ev.output.map(fn => relpath(rootdir, fn)).join(', ')
        )
        break
      case 'END':          // finished building all bundles
        break
      case 'ERROR':        // encountered an error while bundling
        logBuildError(ev.error)
        break
      case 'FATAL': {       // encountered an unrecoverable error
        const err = ev.error
        if (err) {
          logBuildError(err)
          if (err.code == 'PLUGIN_ERROR' && err.plugin == 'rpt2') {
            // TODO: retry buildIncrementally() when source changes
          }
        } else {
          console.error('unknown error')
        }
        break
      }
      default:
        console.log('rollup event:', ev.code, ev)
    }
  })
}


function buildOnce() {
  let startTime = Date.now()
  console.log(`build ${relpath(rootdir, rout.file)} ...`)
  rollup.rollup(rin).then(bundle => {
    // console.log(`imports: (${bundle.imports.join(', ')})`)
    // console.log(`exports: (${bundle.exports.join(', ')})`)
    // bundle.modules is an array of module objects

    bundle.generate(rout).then(({ code, map }) => {
      let p
      if (debug) {
        code += '\n//# sourceMappingURL=' + Path.basename(mapfile)
        p =  Promise.all([
          writefile(mapfile, map.toString(), 'utf8'),
          writefile(outfile, code, 'utf8'),
        ])
      } else {
        map = patchSourceMap(map)
        p = genOptimized(code, map)
      }

      return p.then(() => {
        reportBuilt(Date.now() - startTime, relpath(rootdir, rout.file))
      })
    })

    // return bundle.write(rout).then(() => {
    //   let duration = Date.now() - startTime
    //   reportBuilt(duration, relpath(rootdir, rout.file))
    // })
  }).catch(err => {
    logBuildError(err)
    process.exit(1)
  })
}


function logBuildError(err) {
  if (err.code == 'PLUGIN_ERROR') {
    // don't include stack trace
    let msg = err.message || ''+err
    if (err.plugin == 'rpt2') {
      // convert weird typescript origins `file(line,col):` to standard
      // `file:line:col:`
      msg = msg.replace(
        /(\n|^)(.+)\((\d+),(\d+)\)/g, '$1$2:$3:$4'
      )
    }
    console.log(msg)
  } else {
    console.error(err.stack || ''+err)
  }
}


function reportBuilt(duration, outfiles) {
  console.log(`built ${outfiles} in ${ Math.round((duration/100))/10 }s`)
}


function patchSourceMap(m) { // :Promise<string>
  delete m.sourcesContent

  const srcDirRel = relpath(outdir, srcdir)
  const sourceRootRel = dirname(srcDirRel)

  m.sourceRoot = srcDirRel

  m.sources = m.sources.map(path => {
    if (path.startsWith(srcDirRel)) {
      const abspath = Path.resolve(outdir, path)
      return relpath(srcdir, abspath)
    }
    return path
  })

  return m
  // const json = JSON.stringify(m)
  // return writefile(mapfilename, json, 'utf8').then(() => m)
}


function genOptimized(code, map) { // :Promise<void>
  return new Promise(resolve => {
    console.log(`optimizing...`)

    // need to clear sourceRoot for uglify to produce correct source paths
    const mapSourceRoot = map.sourceRoot
    map.sourceRoot = ''
    // const mapjson = JSON.stringify(map)

    const pureFuncList = [
      // list of known global pure functions that doesn't have any side-effects,
      // provided by the environment.
      'Math.floor',
      'Math.ceil',
      'Math.round',
      'Math.random',
      // TODO: expand this list
    ]

    const infilename = Path.relative(rootdir, outfile)

    var result = UglifyJS.minify({[infilename]: code}, {
      ecma: 8,
      warnings: true,
      toplevel: rout.format == 'cjs',

      // compress: false,
      compress: {
        // arrows: false,
        // (default: `true`) -- Converts `()=>{return x}` to `()=>x`. Class
        // and object literal methods will also be converted to arrow expressions if
        // the resultant code is shorter: `m(){return x}` becomes `m:()=>x`.
        // This transform requires that the `ecma` compress option is set to `6` or greater.

        // booleans: false,
        // (default: `true`) -- various optimizations for boolean context,
        // for example `!!a ? b : c → a ? b : c`

        // collapse_vars: false,
        // (default: `true`) -- Collapse single-use non-constant variables,
        // side effects permitting.

        // comparisons: false,
        // (default: `true`) -- apply certain optimizations to binary nodes,
        // e.g. `!(a <= b) → a > b` (only when `unsafe_comps`), attempts to negate binary
        // nodes, e.g. `a = !b && !c && !d && !e → a=!(b||c||d||e)` etc.

        // computed_props: false,
        // (default: `true`) -- Transforms constant computed properties
        // into regular ones: `{["computed"]: 1}` is converted to `{computed: 1}`.

        // conditionals: false,
        // (default: `true`) -- apply optimizations for `if`-s and conditional
        // expressions

        // dead_code: false,
        // (default: `true`) -- remove unreachable code

        // drop_console: false,
        // (default: `false`) -- Pass `true` to discard calls to
        // `console.*` functions. If you wish to drop a specific function call
        // such as `console.info` and/or retain side effects from function arguments
        // after dropping the function call then use `pure_funcs` instead.

        // drop_debugger: false,
        // (default: `true`) -- remove `debugger;` statements

        // ecma: 5,
        // (default: `5`) -- Pass `6` or greater to enable `compress` options that
        // will transform ES5 code into smaller ES6+ equivalent forms.

        evaluate: true,
        // (default: `true`) -- attempt to evaluate constant expressions

        // expression: true,
        // (default: `false`) -- Pass `true` to preserve completion values
        // from terminal statements without `return`, e.g. in bookmarklets.

        global_defs: defines_inline,
        // (default: `{}`) -- see [conditional compilation](#conditional-compilation)

        // hoist_funs: false,
        // (default: `false`) -- hoist function declarations

        // hoist_props: false,
        // (default: `true`) -- hoist properties from constant object and
        // array literals into regular variables subject to a set of constraints. For example:
        // `var o={p:1, q:2}; f(o.p, o.q);` is converted to `f(1, 2);`. Note: `hoist_props`
        // works best with `mangle` enabled, the `compress` option `passes` set to `2` or higher,
        // and the `compress` option `toplevel` enabled.

        hoist_vars: true,
        // (default: `false`) -- hoist `var` declarations (this is `false`
        // by default because it seems to increase the size of the output in general)

        // if_return: false,
        // (default: `true`) -- optimizations for if/return and if/continue

        // inline: false,
        // (default: `true`) -- embed simple functions

        // join_vars: false,
        // (default: `true`) -- join consecutive `var` statements

        keep_classnames: true,
        // (default: `false`) -- Pass `true` to prevent the
        // compressor from discarding class names.  See also: the `keep_classnames`
        // [mangle option](#mangle).

        // keep_fargs: true,
        // (default: `true`) -- Prevents the compressor from discarding unused
        // function arguments.  You need this for code which relies on `Function.length`.

        // keep_fnames: true,
        // (default: `false`) -- Pass `true` to prevent the
        // compressor from discarding function names.  Useful for code relying on
        // `Function.prototype.name`. See also: the `keep_fnames` [mangle option](#mangle).

        keep_infinity: true,
        // (default: `false`) -- Pass `true` to prevent `Infinity` from
        // being compressed into `1/0`, which may cause performance issues on Chrome.

        // loops: false,
        // (default: `true`) -- optimizations for `do`, `while` and `for` loops
        // when we can statically determine the condition.

        // negate_iife: false,
        // (default: `true`) -- negate "Immediately-Called Function Expressions"
        // where the return value is discarded, to avoid the parens that the
        // code generator would insert.

        passes: 2,
        // (default: `1`) -- The maximum number of times to run compress.
        // In some cases more than one pass leads to further compressed code.  Keep in
        // mind more passes will take more time.

        // properties: false,
        // (default: `true`) -- rewrite property access using the dot notation, for
        // example `foo["bar"] → foo.bar`

        pure_funcs: pureFuncList,
        // (default: `null`) -- You can pass an array of names and
        // UglifyJS will assume that those functions do not produce side
        // effects.  DANGER: will not check if the name is redefined in scope.
        // An example case here, for instance `var q = Math.floor(a/b)`.  If
        // variable `q` is not used elsewhere, UglifyJS will drop it, but will
        // still keep the `Math.floor(a/b)`, not knowing what it does.  You can
        // pass `pure_funcs: [ 'Math.floor' ]` to let it know that this
        // function won't produce any side effect, in which case the whole
        // statement would get discarded.  The current implementation adds some
        // overhead (compression will be slower).

        // pure_getters: undefined,
        // (default: `"strict"`) -- If you pass `true` for
        // this, UglifyJS will assume that object property access
        // (e.g. `foo.bar` or `foo["bar"]`) doesn't have any side effects.
        // Specify `"strict"` to treat `foo.bar` as side-effect-free only when
        // `foo` is certain to not throw, i.e. not `null` or `undefined`.

        // reduce_funcs: false,
        // (default: `true`) -- Allows single-use functions to be
        // inlined as function expressions when permissible allowing further
        // optimization.  Enabled by default.  Option depends on `reduce_vars`
        // being enabled.  Some code runs faster in the Chrome V8 engine if this
        // option is disabled.  Does not negatively impact other major browsers.

        // reduce_vars: false,
        // (default: `true`) -- Improve optimization on variables assigned with and
        // used as constant values.

        // sequences: false,
        // (default: `true`) -- join consecutive simple statements using the
        // comma operator.  May be set to a positive integer to specify the maximum number
        // of consecutive comma sequences that will be generated. If this option is set to
        // `true` then the default `sequences` limit is `200`. Set option to `false` or `0`
        // to disable. The smallest `sequences` length is `2`. A `sequences` value of `1`
        // is grandfathered to be equivalent to `true` and as such means `200`. On rare
        // occasions the default sequences limit leads to very slow compress times in which
        // case a value of `20` or less is recommended.

        // side_effects: false,
        // (default: `true`) -- Pass `false` to disable potentially dropping
        // functions marked as "pure".  A function call is marked as "pure" if a comment
        // annotation `/*@__PURE__*/` or `/*#__PURE__*/` immediately precedes the call. For
        // example: `/*@__PURE__*/foo();`

        // switches: false,
        // (default: `true`) -- de-duplicate and remove unreachable `switch` branches

        // toplevel: false,
        // (default: `false`) -- drop unreferenced functions (`"funcs"`) and/or
        // variables (`"vars"`) in the top level scope (`false` by default, `true` to drop
        // both unreferenced functions and variables)

        // top_retain: null,
        // (default: `null`) -- prevent specific toplevel functions and
        // variables from `unused` removal (can be array, comma-separated, RegExp or
        // function. Implies `toplevel`)

        // typeofs: false,
        // (default: `true`) -- Transforms `typeof foo == "undefined"` into
        // `foo === void 0`.  Note: recommend to set this value to `false` for IE10 and
        // earlier versions due to known issues.

        // unsafe: false,
        // (default: `false`) -- apply "unsafe" transformations (discussion below)

        // unsafe_arrows: true,
        // (default: `false`) -- Convert ES5 style anonymous function
        // expressions to arrow functions if the function body does not reference `this`.
        // Note: it is not always safe to perform this conversion if code relies on the
        // the function having a `prototype`, which arrow functions lack.
        // This transform requires that the `ecma` compress option is set to `6` or greater.

        // unsafe_comps: false,
        // (default: `false`) -- Reverse `<` and `<=` to `>` and `>=` to
        // allow improved compression. This might be unsafe when an at least one of two
        // operands is an object with computed values due the use of methods like `get`,
        // or `valueOf`. This could cause change in execution order after operands in the
        // comparison are switching. Compression only works if both `comparisons` and
        // `unsafe_comps` are both set to true.

        // unsafe_Func: false,
        // (default: `false`) -- compress and mangle `Function(args, code)`
        // when both `args` and `code` are string literals.

        // unsafe_math: false,
        // (default: `false`) -- optimize numerical expressions like
        // `2 * x * 3` into `6 * x`, which may give imprecise floating point results.

        // unsafe_methods: false,
        // (default: false) -- Converts `{ m: function(){} }` to
        // `{ m(){} }`. `ecma` must be set to `6` or greater to enable this transform.
        // If `unsafe_methods` is a RegExp then key/value pairs with keys matching the
        // RegExp will be converted to concise methods.
        // Note: if enabled there is a risk of getting a "`<method name>` is not a
        // constructor" TypeError should any code try to `new` the former function.

        // unsafe_proto: false,
        // (default: `false`) -- optimize expressions like
        // `Array.prototype.slice.call(a)` into `[].slice.call(a)`

        // unsafe_regexp: false,
        // (default: `false`) -- enable substitutions of variables with
        // `RegExp` values the same way as if they are constants.

        // unused: true,
        // (default: `true`) -- drop unreferenced functions and variables (simple
        // direct variable assignments do not count as references unless set to
        // `"keep_assign"`)

        // warnings: false,
        // (default: `false`) -- display warnings when dropping unreachable
        // code or unused declarations etc.
      },

      // mangle: false,
      mangle: minify ? {
        // reserved: [],
        keep_classnames: true,
        keep_fnames: false,
        safari10: false,
      } : false,

      output: {
        preamble: rout.banner.trim(),
          // Note: uglify adds a trailing newline after preamble
        beautify: !minify,
        indent_level: 2,
        // comments: true,
        ast: false,
        code: true,
        safari10: false,
      },
      sourceMap: {
        content: map,
        root: mapSourceRoot,
        url: Path.basename(mapfile),
        filename: Path.basename(outfile),
      },
    })

    if (result.error) {
      throw result.error
    }

    console.log(
      `write ${fmtsize(result.code.length)} to ${relpath(rootdir, outfile)}`)
    console.log(
      `write ${fmtsize(result.map.length)} to ${relpath(rootdir, mapfile)}`)
    resolve(Promise.all([
      writefile(outfile, result.code, 'utf8'),
      writefile(mapfile, result.map, 'utf8'),
    ]))
  })
}


function fmtsize(z) {
  return (z / 1024).toFixed(1) + ' kB'
}


function getGlobalJSSync() {
  const srcfile = pjoin(srcdir, 'global.js')
  const cachefile = pjoin(outdir, '.global.'+(debug ? 'd':'r')+'.cache.js')

  try {
    const srcst = fs.statSync(srcfile)
    const cachest = fs.statSync(cachefile)
    if (
      (srcst.mtimeMs !== undefined && srcst.mtimeMs <= cachest.mtimeMs) ||
      (srcst.mtimeMs === undefined && srcst.mtime <= cachest.mtime)
    ) {
      return fs.readFileSync(cachefile, 'utf8')
    }
  } catch (_) {}

  console.log(`build ${relpath(rootdir, srcfile)}`)

  const r = compileJS(srcfile, fs.readFileSync(srcfile, 'utf8'))
  if (r.error) {
    const err = r.error
    if (err.line !== undefined) {
      err.message =
        `${err.filename || err.file}:${err.line}:${err.col} ${r.message}`
    }
    throw err
  }

  try { fs.mkdirSync(dirname(cachefile)) } catch(_) {}
  fs.writeFileSync(cachefile, r.code, 'utf8')
  return r.code
}


function compileJS(name, source) { // :{ error? :Error, code :string }
  const res = UglifyJS.minify({[name] : source}, {
    ecma:  6,
    parse: {},
    compress: {
      dead_code: true,
      global_defs: defines_inline,
    },
    mangle: false,
    output: {
      ast: false,
      code: true,
      preserve_line: debug, // poor man's sourcemap :-)
    },
  })
  return res
}


function getGitHashSync() {
  try {
    return subprocess.execSync('git rev-parse HEAD', {
      cwd: rootdir,
      timeout: 2000,
    }).toString('utf8').trim()
  } catch (_) {}
  return ''
}