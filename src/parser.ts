import { SrcFile, Pos } from './pos'
import { token, tokstr, prec } from './token'
import * as scanner from './scanner'
import { ErrorHandler, ErrorCode } from './error'
import { TypeResolver } from './resolve'
import { ByteStr, ByteStrSet } from './bytestr'
import { Universe } from './universe'
import { debuglog as dlog } from './util'
import { DiagHandler, DiagKind } from './diag'
import { SInt64, UInt64 } from './int64'
import { Num, numconv, numEval } from './num'
import {
  File,
  Scope,
  Ent,
  Group,
  Comment,

  Node,

  Field,
  Stmt,
  ReturnStmt,
  WhileStmt,
  
  Decl,
  ImportDecl,
  VarDecl,
  TypeDecl,
  MultiDecl,

  Expr,
  Ident,
  // LiteralExpr,
  RestExpr,
  FunExpr,
  FunSig,
  NumLit,
  StringLit,
  Block,
  IfExpr,
  Assignment,
  Operation,
  CallExpr,
  // ParenExpr,
  TupleExpr,
  BadExpr,
  SelectorExpr,
  IndexExpr,
  SliceExpr,

  Type,
  // BasicType,
  NumType, // MemType,
  IntType,
  FunType,
  StrType,
  UnresolvedType,
  UnionType,
  TupleType,

  u_t_nil,
  u_t_auto,
  u_t_i32, u_t_u32,
  u_t_i64, u_t_u64,
  u_t_f32, u_t_f64,
} from './ast'

const kEmptyByteArray = new Uint8Array(0)
const kBytes__ = new Uint8Array([0x5f]) // '_'
const kBytes_dot = new Uint8Array([0x2e]) // '.'
const kBytes_init = new Uint8Array([0x69, 0x6e, 0x69, 0x74]) // 'init'

const emptyExprList :Expr[] = []

type exprCtx = Assignment|VarDecl|null


// funInfo contains information about the current function, used for data
// that is really only needed during parsing.
class funInfo {
  autort :UnionType|null = null // inferred result types

  constructor(
  public f :FunExpr, // the respective function node
  ){}

  addInferredReturnType(t :Type) {
    if (this.autort == null) {
      this.autort = new UnionType(new Set<Type>([t]))
    } else {
      this.autort.add(t)
    }
  }
}


// Parser scans source code and produces AST.
// It must be initialized via init before use or resue.
//
export class Parser extends scanner.Scanner {
  fnest      :int = 0   // function nesting level (for error handling)
  universe   :Universe
  strSet     :ByteStrSet
  comments   :Comment[]|null
  scope      :Scope
  filescope  :Scope
  pkgscope   :Scope
  diagh      :DiagHandler|null = null
  initfnest  :int = 0  // tracks if we're inside an init function
  unresolved :Set<Ident>|null   // unresolved identifiers
  funstack   :funInfo[]  // function stack
  types      :TypeResolver

  _id__      :ByteStr
  _id_dot    :ByteStr
  _id_init   :ByteStr

  initParser(
    sfile      :SrcFile,
    sdata      :Uint8Array,
    universe   :Universe,
    pkgscope   :Scope|null,
    typeres    :TypeResolver,
    errh       :ErrorHandler|null = null,
    diagh      :DiagHandler|null = null,
    smode      :scanner.Mode = scanner.Mode.None,
  ) {
    const p = this
    super.init(sfile, sdata, errh, smode)
    p.scope = new Scope(pkgscope)
    p.filescope = p.scope
    p.pkgscope = pkgscope || p.filescope
    
    p.fnest = 0
    p.universe = universe
    p.strSet = universe.strSet
    p.comments = null
    p.diagh = diagh
    p.initfnest = 0
    p.unresolved = null
    p.funstack = []
    p.types = typeres

    p._id__ = p.strSet.emplace(kBytes__)
    p._id_dot = p.strSet.emplace(kBytes_dot)
    p._id_init = p.strSet.emplace(kBytes_init)

    if (smode & scanner.Mode.ScanComments) {
      p.next = p.next_comments
    }

    p.next()
  }

  next_comments() {
    const p = this
    super.next()
    while (p.tok == token.COMMENT) {
      if (!p.comments) {
        p.comments = []
      }
      p.comments.push(new Comment(p.pos, p.takeByteValue()))
      super.next()
    }
    // TODO: Figure out a way to attach comments to nodes
  }

  got(tok :token) :bool {
    const p = this
    if (p.tok == tok) {
      p.next()
      return true
    }
    return false
  }
  
  want(tok :token) {
    const p = this
    if (!p.got(tok)) {
      p.syntaxError(`expecting ${tokstr(tok)}`)
      p.next()
    }
  }

  // inFun() :FunExpr|null {
  //   return this.funstack[0] || null
  // }

  currFun() :funInfo {
    assert(this.funstack.length > 0, 'access current function at file level')
    return this.funstack[0]
  }

  pushFun(f :FunExpr) {
    this.funstack.push(new funInfo(f))
  }

  popFun() {
    assert(this.funstack.length > 0, 'popFun with empty funstack')
    this.funstack.pop()
  }


  pushScope(scope :Scope | null = null) {
    const p = this
    if (scope) {
      assert(scope.outer != null, 'pushing scope without outer scope')
    }
    p.scope = scope || new Scope(p.scope)
    // dlog(`${(p as any).scope.outer.level()} -> ${p.scope.level()}`)
  }

  popScope() :Scope { // returns old ("popped") scope
    const p = this
    const s = p.scope
    
    assert(s !== p.filescope, "pop file scope")
    assert(s !== p.pkgscope, "pop file scope")
    assert(p.scope.outer != null, 'pop scope at base scope')

    // dlog(` ${(p as any).scope.outer.level()} <- ${p.scope.level()}`)

    p.scope = p.scope.outer as Scope

    // check for unused declarations
    if (s.decls) for (let [name, ent] of s.decls) {
      if (ent.nreads == 0) {
        if (ent.decl instanceof Field) {
          p.diag("warn", `${name} not used`, ent.decl.pos, (
            ent.decl.scope.isFunScope ? 'E_UNUSED_PARAM' :
            'E_UNUSED_FIELD'
          ))
        } else {
          p.diag(
            "warn",
            `${name} declared and not used`,
            ent.decl.pos,
            'E_UNUSED_VAR'
          )
        }
      }
    }

    return s
  }

  declare(scope :Scope, ident: Ident, decl :Node, x: Expr|null) {
    const p = this

    if (ident.value === p._id__) {
      // "_" is never declared
      return
    }

    assert(ident.ent == null, `redeclaration of ${ident}`)

    const ent = new Ent(ident.value, decl, x)
    if (!scope.declareEnt(ent)) {
      p.syntaxError(`${ident} redeclared`, ident.pos)
    }

    ident.ent = ent
    // TODO: in the else branch, we could count locals/registers needed here.
    // For instance, "currFun().local_i32s_needed++"
  }

  declarev(scope :Scope, idents: Ident[], decl :Node, xs: Expr[]|null) {
    const p = this
    for (let i = 0; i < idents.length; ++i) {
      p.declare(scope, idents[i], decl, xs && xs[i] || null)
    }
  }

  // If x is an identifier, resolve attempts to resolve x by looking up
  // the entity it denotes. If no entity is found and collectUnresolved is
  // set, x is marked as unresolved and collected in the list of unresolved
  // identifiers.
  // Returns the input expression
  //
  resolve<N extends Expr>(x :N, collectUnresolved :bool = true) :N {
    const p = this

    // nothing to do if x is not an identifier or the blank identifier
    if (!(x instanceof Ident) || x.value === p._id__) {
      return x
    }

    assert(x.ent == null, "already resolved")

    if (x.value === p._id__) {
      return x
    }

    // try to resolve the identifier
    let s :Scope|null = x.scope
    while (s) {
      const ent = s.lookupImm(x.value)
      if (ent) {
        // dlog(`${x} found in scope#${s.level()}`)
        x.refEnt(ent) // reference ent

        if (!x.type) {
          const tx = ent.getTypeExpr()
          x.type = tx ? p.types.resolve(tx) : null
          // x.type = (
          //   ent.value ? p.types.resolve(ent.value) :
          //   ent.decl instanceof Expr ? p.types.resolve(ent.decl) :
          //   null
          // )

          if (!x.type) {
            x.type = p.types.markUnresolved(x)
          }
          if (x.type instanceof UnresolvedType) {
            // references something that itself is undefined
            x.type.addRef(x)
          }
        }

        return x
      }
      s = s.outer
    }

    // dlog(`${x} not found`)
    if (collectUnresolved) {
      // all local scopes are known, so any unresolved identifier
      // must be found either in the file scope, package scope
      // (perhaps in another file), or universe scope --- collect
      // them so that they can be resolved later
      if (!p.unresolved) {
        p.unresolved = new Set<Ident>([x])
      } else {
        p.unresolved.add(x)
      }
    }

    return x
  }

  // ctxType returns the type of the context, or null if the type is not known
  // or if the type can't be reliably inferred, in which case it should be
  // resolved later on.
  //
  ctxType(ctx :exprCtx) :Type|null {
    const p = this
    if (ctx) {
      if (ctx instanceof VarDecl) {
        return ctx.type && p.types.maybeResolve(ctx.type) || null
      }
      if (ctx instanceof Assignment) {
        // common case: single assignment
        // we handle multi assignments later, in p.assignment()
        return (
          ctx.lhs && ctx.lhs.length == 1 ? p.types.maybeResolve(ctx.lhs[0]) :
          null
        )
      }
    }
    return null
  }

  parseFile() :File {
    const p = this
    const imports = p.parseImports()
    const decls = p.parseFileBody()

    return new File(
      p.sfile,
      p.scope,
      imports,
      decls,
      p.unresolved,
    )
  }

  parseImports() :ImportDecl[] {
    const p = this
    //
    // Imports     = ImportDecl? | ImportDecl (";" ImportDecl)*
    // ImportDecl  = "import" ( ImportSpec | "(" { ImportSpec ";" } ")" )
    // ImportSpec  = [ "." | PackageName ] ImportPath
    // ImportPath  = string_lit
    //
    let imports = [] as ImportDecl[]
    while (p.got(token.IMPORT)) {
      p.appendGroup(imports, p.importDecl)
      p.want(token.SEMICOLON)
    }
    return imports
  }

  importDecl = (group :Group|null) :ImportDecl => {
    const p = this
    let localIdent :Ident|null = null
    let hasLocalIdent = false
  
    switch (p.tok) {
      case token.NAME:
        localIdent = p.ident()
        hasLocalIdent = true
        break

      case token.DOT:
        const s = p._id_dot
        localIdent = new Ident(p.pos, p.scope, s)
        p.next()
        break
    }

    let path :StringLit
    if (p.tok == token.STRING) {
      path = p.strlit()
    } else {
      p.syntaxError("missing import path; expecting quoted string")
      path = new StringLit(p.pos, p.scope, kEmptyByteArray)
      p.advanceUntil(token.SEMICOLON, token.RPAREN)
    }

    const d = new ImportDecl(p.pos, p.scope, path, localIdent)
    // d.Group = group

    if (hasLocalIdent && localIdent) {
      p.declare(p.filescope, localIdent, d, null)
    }
    
    return d
  }

  parseFileBody() :Decl[] {
    const p = this
    const decls = [] as Decl[]

    // { TopLevelDecl ";" }
    while (p.tok != token.EOF) {
      switch (p.tok) {

        case token.TYPE:
          p.next() // consume "type"
          p.appendGroup(decls, p.typeDecl)
          break

        case token.NAME:
          const pos = p.pos
          const idents = p.identList(p.ident())
          decls.push(p.varDecl(pos, idents))
          break

        case token.FUN:
          decls.push(p.funExpr(null))
          break

        // TODO: token.TYPE

        default: {
          if (
            p.tok == token.LBRACE &&
            decls.length > 0 &&
            isEmptyFunExpr(decls[decls.length-1])
          ) {
            // opening { of function declaration on next line
            p.syntaxError("unexpected semicolon or newline before {")
          } else {
            p.syntaxError("non-declaration statement outside function body")
          }

          p.error(`TODO file-level token \`${tokstr(p.tok)}\``); p.next()

          p.advanceUntil(/*token.CONST, */token.TYPE, token.FUN)
          continue
        }
      }

      if ((p.tok as token) != token.EOF && !p.got(token.SEMICOLON)) {
        p.syntaxError("after top level declaration")
        p.advanceUntil(/*token.CONST, */token.TYPE, token.FUN)
      }
    }

    return decls
  }

  // checkDeclLen verifies that idents.length == nvalues, and if not,
  // reports a syntax error.
  // Returns true if lengths matches.
  //
  checkDeclLen(idents :Ident[], nvalues: number, kind :string) :bool {
    const p = this
    if (nvalues != idents.length) {
      p.syntaxError(
        `cannot assign ${nvalues} values to ${idents.length} ${kind}`,
        idents[0].pos
      )
      return false
    }
    return true
  }

  typeDecl = (group :Group|null, nth :int) :TypeDecl => {
    // TypeSpec = "type" identifier [ "=" ] Type
    const p = this
    const pos = p.pos
    const ident = p.ident()
    const alias = p.got(token.ASSIGN)

    let t = p.maybeType()
    if (!t) {
      t = p.bad()
      p.syntaxError("in type declaration")
      p.advanceUntil(token.SEMICOLON, token.RPAREN)
    }

    const d = new TypeDecl(pos, p.scope, ident, alias, t, group)
    // TODO: declare in scope
    return d
  }

  varDecl(pos :Pos, idents :Ident[]) :VarDecl|Assignment {
    // VarDecl = IdentifierList
    //           ( Type [ "=" ExpressionList ] | "=" ExpressionList )
    const p = this
    const typ = p.maybeType()
    let isError = false

    // vars at the file level are declared in the package scope
    const scope = p.scope === p.filescope ? p.pkgscope : p.scope

    // if (p.scope !== p.filescope && p.tok == token.ASSIGN) {
    //   // produce Assignment instead
    //   return p.assignment(idents, typ ? p.types.resolve(typ) : null)
    // }

    const d = new VarDecl(pos, scope, idents, null, typ, null)

    if (p.got(token.ASSIGN)) {
      // e.g. x, y = 1, 2
      d.values = p.exprList(/*ctx=*/d)
      isError = !p.checkDeclLen(idents, d.values.length, 'constants')
    } else if (!typ) {
      // e.g. `x` -- missing type or values
      p.syntaxError("unexpected identifier", pos)
      isError = true
      d.values = [p.bad()]
      p.advanceUntil(token.SEMICOLON)
    }

    if (isError) {
      return d
    }

    const reqt = d.type ? p.types.resolve(d.type) : null
    p.processAssign(d.idents, d.values, d, reqt, /*onlyDef=*/true)

    return d
  }

  funExpr(ctx :exprCtx) :FunExpr {
    //
    // FunExpr  = "fun" FunName? Signature? FunBody?
    // FunName  = identifier
    // FunBody  = ( Block | "->" Stmt )
    //
    // Note: FunName is required at file level in "fun" declarations
    //
    const p = this
    const pos = p.pos
    p.want(token.FUN)

    const isTopLevel = p.scope === p.filescope

    let name :Ident|null
    let isInitFun = false

    if (isTopLevel && !ctx) {
      // case: statement(!ctx) at top-level
      name = p.ident()
      // functions called "init" at the file level are special
      isInitFun = p.scope === p.filescope && name.value.equals(p._id_init)
    } else {
      name = p.maybeIdent()
    }

    // scope in which we will declare the function's name.
    // declarations at the top-level are declared in the package scope.
    const scope = isTopLevel ? p.pkgscope : p.scope

    // new scope for parameters, signature and body
    p.pushScope(new Scope(p.scope, null, /*isFunScope*/true))

    // parse signature.
    //
    // Note: we use the default and special type constant "auto" for all
    // functions but initi functions. This allows us to track multiple return
    // sites and do type checking as we go.
    //
    // Additionally, p.funSig may find an explicit return type in which case
    // it will use that instead. Whenever we encounter a return statement, we
    // will check the expected return type with the actual return type.
    //
    const sig = p.funSig(isInitFun ? u_t_nil : u_t_auto)

    const f = new FunExpr(pos, p.scope, name, sig, isInitFun)

    if (isInitFun) {
      // check initfun signature (should be empty)
      if (sig.params.length > 0) {
        p.syntaxError(`init function with parameters`, sig.pos)
      }
      if (sig.result !== u_t_nil/*u_t_void*/) {
        p.syntaxError(`init function with result`, sig.pos)
      }
    } else {
      if (sig.result !== u_t_auto) {
        // an explicit type was provided -- resolve type
        p.types.resolve(sig.result)
      }

      if (name && !ctx) {
        // The function itself is declared in its outer scope, so that its body
        // can refer to the function, but also so that "funname = x" declares a
        // new variable rather than replacing the function.
        //
        // The check for !ctx is to make sure that decorative names in
        // expressions are not declared in the scope.
        // E.g. the statement "x = fun y(){}" should only declare x in the scope,
        // but not y.
        p.declare(scope, name, f, f)
      }
    }

    // parse body
    if (!isTopLevel || isInitFun || ctx || p.tok != token.SEMICOLON) {

      // Note: the following code can be enabled to disallow type-only param
      // signatures for functions with bodies.
      // e.g. "fun foo(int, f32) {}"
      // if (sig.params.length > 0 && !sig.params[0].name) {
      //   p.syntaxError(
      //     `type-only parameters for function with body`,
      //     sig.pos
      //   )
      // }

      if (isInitFun) { p.initfnest++ }
      p.pushFun(f)

      f.body = p.funBody(name)
      const fi = p.currFun()

      p.popFun()
      if (isInitFun) { p.initfnest-- }

      // pop function body scope before resolving types.
      // otherwise we would run the risk of resolving a type to something
      // that's defined in the function body itself which may shadow outer
      // definitions.
      p.popScope()

      if (f.body instanceof Block) {
        if (sig.result === u_t_auto) {
          // functions with block bodies that lack result type
          // produces no result.
          sig.result = u_t_nil
        }

        // handle implicit return
        if (!isInitFun && sig.result !== u_t_nil) {
          let lastindex = f.body.list.length - 1
          let result = f.body.list[lastindex]
          if (result instanceof Expr) {
            let rettype = p.types.resolve(result)
            let ret = new ReturnStmt(result.pos, result.scope, result, rettype)
            f.body.list[lastindex] = ret
          }
        }
      }

      if (sig.result === u_t_auto) {
        // inferred result type
        if (fi.autort == null) {
          // no return statements encountered.
          // set result type to same as the body
          sig.result = p.types.resolve(f.body)
        } else if (fi.autort.types.size == 1) {
          // single return type (note: may be void if found `return;`)
          sig.result = fi.autort.types.values().next().value
        } else {
          // union type
          sig.result = fi.autort
        }
      }
    } else {
      if (sig.result == u_t_auto) {
        // for functions without a body and that is missing an explicit
        // result type, nil/void is assumed.
        sig.result = u_t_nil //u_t_void
      }
      p.popScope()
    }

    if (sig.result instanceof UnresolvedType) {
      sig.result.addRef(sig)
    }

    const funtype = p.types.resolve(f) as FunType
    assert(funtype.constructor === FunType) // funtype always resolves

    if (name && name.value !== p._id__ && !isInitFun) {
      // since we declared the name of the function, the name now represents
      // the function and thus its type.
      name.type = funtype
    }

    return f
  }

  // TODO: maybeFunExpr() :Expr -- FunExpr or some other expr
  // FunExpr = "fun" FunName? Signature FunBody
  // FunName = identifier
  // FunBody  = ( Block | "->" Stmt )

  funSig(defaultType :Type): FunSig {
    // Signature = ( Parameters Result? | Type )?
    const p = this
    const pos = p.pos
    const params = p.tok == token.LPAREN ? p.parameters() : []
    const result = p.maybeType() || defaultType
    return new FunSig(pos, p.scope, params, result)
  }

  parameters() :Field[] {
    // Parameters    = "(" [ ParameterList [ "," ] ] ")"
    // ParameterList = ParameterDecl ("," ParameterDecl)*
    // ParameterDecl = [ NameList ] [ "..." ] Type
    //
    // T
    // x T
    // x, y, z T
    // ... T
    // x  ... T
    // x, y, z  ... T
    // T1, T2, T3
    // T1, T2, ... T3
    //
    const p = this
    p.want(token.LPAREN)

    let named = 0   // parameters that have an explicit name and type
    let seenRestExpr = false
    const paramsPos = p.pos
    const fields = [] as Field[]
    const scope = p.scope

    while (p.tok != token.RPAREN) {
      let pos = p.pos
      // let f = new Field(p.pos, scope, u_t_auto, p.ident())
      
      let typ :Expr = u_t_auto
      let name :Ident|null = null

      // parse type or name
      if (p.tok == token.NAME) {
        typ = p.dotident(null, p.ident())
      } else {
        // Note: No need to check for ";" or ")" since the "while" condition
        // checks for ")" and an empty parameter set with linebreaks never
        // produces a semicolon implicitly. I.e. "foo(<LF><LF>)" == "foo()"
        // However, it's a syntax error to write "foo(;)"
        const x = p.maybeType()
        if (x) {
          typ = x
        } else {
          typ = p.bad()
          p.syntaxError("expecting name or type")
          // p.next()
        }
      }

      if (p.tok != token.COMMA &&
          p.tok != token.SEMICOLON &&
          p.tok as token != token.RPAREN)
      {
        // e.g. func(T), func(... T)

        // move typ -> name as we are about to parse the actual type
        if (typ) {
          // e.g. func(name T)
          if (typ instanceof Ident) {
            name = typ
            named++
          } else {
            // e.g. func(a.b.c T)
            p.syntaxError("illegal parameter name", pos)
          }
        }

        // parse type
        if (p.got(token.ELLIPSIS)) {
          const x = p.maybeType()
          if (x) {
            typ = new RestExpr(pos, scope, x)
          } else {
            typ = p.bad()
            p.syntaxError("expecting type after ...")
          }
          if (seenRestExpr) {
            p.syntaxError("can only use ... with final parameter")
            continue  // skip this field
          } else {
            seenRestExpr = true
          }
        } else {
          typ = p.type()
        }
      }

      // restType() :RestExpr {
      //   // RestType = "..." Expr?
      //   const p = this
      //   const pos = p.pos
      //   p.want(token.ELLIPSIS)
      //   const rt = new RestExpr(pos, p.scope, p.type())
      //   p.types.resolve(rt)
      //   return rt
      // }

      // parse optional comma, or break on error
      if (!p.ocomma(token.RPAREN)) {
        // error: unexpected SOMETHING, expecting comma, or )
        // e.g. "fun foo(a, b<LF>)" fix -> "fun foo(a, b,<LF>)"
        //                                              ^
        break
      }

      fields.push(new Field(pos, scope, typ, name))
    }

    p.want(token.RPAREN)

    // distribute parameter types
    if (named == 0) {
      // none named -- types only
      for (let f of fields) {
        p.resolve(f.type)
      }
    } else {

      if (named < fields.length) {
        // All named, some has types, e.g. func(a, b B, c ...C)
        // some named => all must be named
        let ok = true
        let typ :Expr|null = null
        let t :Type = u_t_auto

        for (let i = fields.length - 1; i >= 0; --i) {
          const f = fields[i]

          if (!f.name) {
            // is a single-name param (name is actually on .type)
            if (f.type instanceof Ident) {
              f.name = f.type
              if (typ) {
                f.type = typ
                f.name.type = t
              } else {
                // f.type == nil && typ == null => we only have a f.name
                ok = false
                f.type = p.bad(f.type.pos)
              }
            } else {
              p.syntaxError("illegal parameter name", f.type.pos)
            }
          } else if (f.type) {
            p.resolve(f.type)
            t = p.types.resolve(f.type)
            typ = f.type
            if (typ instanceof RestExpr) {
              typ = typ.expr
            }
            if (f.name) {
              f.name.type = t
            } else {
              ok = false
              f.name = p.fallbackIdent(typ.pos)
            }
          }

          if (!ok) {
            p.syntaxError(
              "mixed named and unnamed function parameters",
              paramsPos
            )
            break
          }

          // declare name in function scope
          assert(f.name != null)
          p.declare(scope, f.name as Ident, f, null)
        }
      } else {
        // All named, all have types
        // declare names in function scope
        for (let f of fields) {
          assert(f.name != null)
          p.resolve(f.type)
          ;(f.name as Ident).type = p.types.resolve(f.type)
          p.declare(scope, f.name as Ident, f, null)
        }
      }
    }

    return fields
  }

  funBody(funcname :Ident|null) :Expr {
    // FunBody = ( Block | "->" Expr )
    const p = this

    if (p.tok == token.LBRACE) {
      // Block
      return p.block()
      // let b = p.block()
      // if (b.list.length > 0) {
      //   let laststmt = b.list[b.list.length-1]
      //   if (laststmt instanceof ReturnExpr) {
      //     // unwrap "return" when it is the last statement in a function, since
      //     // last statement is implicit.
      //     b.list[b.list.length-1] = laststmt.result
      //   }
      // }
      // return b
    }

    if (p.got(token.ARROWR)) {
      // "->" Expr
      return p.expr(/*ctx=*/null)
      // let x = p.expr(/*ctx=*/null)
      // if (x instanceof ReturnExpr) {
      //   // unwrap "return" when it is the last statement in a function, since
      //   // last statement is implicit.
      //   return x.result
      // }
      // return x
    }

    // error
    const pos = p.pos
    if (funcname) {
      p.syntaxError(`${funcname} is missing function body`, pos)
    } else {
      p.syntaxError("missing function body", pos)
    }
    return p.bad(pos)
  }

  // block parses a block expression.
  // The caller manages scope (push/pop if required)
  //
  block() :Block {
    // Block = "{" StatementList "}" | Stmt
    const p = this
    const pos = p.pos
    p.want(token.LBRACE)
    const list = p.stmtList()
    p.want(token.RBRACE)
    return new Block(pos, p.scope, list)
  }

  multiDecl<D extends Decl>(f :(g:Group|null, i:int)=>D) :MultiDecl {
    const p = this
    const pos = p.pos
    p.next() // e.g. TYPE
    const decls :Decl[] = []
    p.appendGroup(decls, f)
    return new MultiDecl(pos, p.scope, decls)
  }

  stmtList() :Stmt[] {
    // StatementList = { Statement ";" }
    const p = this
    const list = [] as Stmt[]

    while (p.tok != token.EOF &&
           p.tok != token.RBRACE &&
           // p.tok != token.CASE &&
           p.tok != token.DEFAULT)
    {
      const s = p.maybeStmt()
      if (!s) {
        break
      }
      list.push(s)
      // customized version of osemi:
      // ';' is optional before a closing ')' or '}'
      if (p.tok == token.RPAREN || p.tok as token == token.RBRACE) {
        continue
      }
      if (!p.got(token.SEMICOLON)) {
        p.syntaxError("at end of statement")
        p.advanceUntil(token.SEMICOLON, token.RBRACE)
      }
    }

    return list
  }

  // shouldStoreToEnt returns true if ent is within atScope in such a way
  // that "ent = value" means "store value to ent".
  //
  shouldStoreToEnt(ent :Ent, atScope :Scope) :bool {
    const p = this
    return (
      ent.scope === atScope  // same scope
      ||
      ( ent.scope !== p.filescope &&
        ( ( ent.scope === p.pkgscope &&
            atScope.fun && atScope.fun.isInit )
          ||
          ent.scope.funScope() === atScope.funScope()
        )
      )
    )
  }


  processAssign(
    lhs :Expr[],
    rhs :Expr[]|null,
    decl :Node,
    reqt :Type|null,
    onlyDef :bool,
  ) {
    const p = this

    // TODO refactor this and move this function (that has a closure)
    function maybeConvRVal(typ :Type, rval :Expr, index :int) {
      if (
        !(rval.type instanceof UnresolvedType) &&
        !(typ instanceof UnresolvedType)
      ) {
        const convx = p.types.convert(typ, rval)
        if (!convx) {
          if (rval.type instanceof UnresolvedType) {
            // unresolved
            return 
          }
          p.error(
            (rval.type instanceof UnresolvedType ?
              `cannot convert "${rval}" to type ${typ}` :
              `cannot convert "${rval}" (type ${rval.type}) to type ${typ}`
            ),
            rval.pos
          )
        } else if (convx !== rval) {
          // no error and conversion is needed.
          // replace original expression with conversion expression
          assert(rhs != null)
          ;(rhs as any)[index] = convx
        }
      }
    }

    // Check each left-hand identifier against scope and unresolved.
    // Note that exprList already has called p.resolve on all ids.
    //
    // If an id has an ent (i.e. was resolved to something), then we simply
    // register the assignment with it so that we can later bind.
    //
    // If an id is unresolved (doesn't have an ent), the semantics are:
    // - assume it's a constant definition and declare it as such
    // - register the assignment so that if we later find a var in the outer
    //   scope, we can convert the declaration to an assignment.
    //
    for (let i = 0; i < lhs.length; ++i) {
      const id = lhs[i]

      if (!(id instanceof Ident)) {
        dlog(`TODO LHS is not an id (type is ${id.constructor.name})`)
        continue
      }

      // Decide to store to an existing ent, or declare a new one
      if (!onlyDef && rhs && id.ent && p.shouldStoreToEnt(id.ent, id.scope)) {
        const rval = rhs[i]

        id.incrWrite()

        const typexpr = id.ent.getTypeExpr()
        assert(typexpr != null)
        const typ = p.types.resolve(typexpr as Expr)

        // check & resolve type, converting rval if needed
        id.type = typ
        maybeConvRVal(typ, rval, i)

        continue
      }

      id.ent = null
      
      // new declaration
      //
      // since we are about to redeclare, clear any "unresolved" mark for
      // this identifier expression.
      const rval = rhs ? rhs[i] : null

      if (reqt) {
        id.type = reqt
        if (rval) {
          // see if we need to convert the rval to fit the destination type
          maybeConvRVal(reqt, rval, i)
        }
      } else {
        assert(rval, "processAssign called with no reqt and no rvals")
        id.type = p.types.resolve(rval as Expr)
      }
      
      if (p.unresolved) { p.unresolved.delete(id) } // may be noop
      p.declare(id.scope, id, decl, rval)

      if (id.type instanceof UnresolvedType) {
        id.type.addRef(id)
      }

    } // end for loop
  }


  assignment(lhs :Expr[], reqt :Type|null = null) :Assignment {
    // Assignment = ExprList "=" ExprList
    const p = this
    p.want(token.ASSIGN) // "="

    const s = new Assignment(lhs[0].pos, p.scope, token.ASSIGN, lhs, [])

    // parse right-hand side in context of the function
    s.rhs = p.exprList(/*ctx=*/s)

    p.processAssign(s.lhs, s.rhs, s, /*reqt=*/reqt, /*onlyDef=*/false)

    p.types.resolve(s)

    return s
  }

  // simpleStmt = EmptyStmt | ExpressionStmt | SendStmt | IncDecStmt
  //            | Assignment | VarDecl
  simpleStmt(lhs :Expr[]) :Stmt {
    const p = this

    // Note: token.SET_ASSIGN ":=" is currently unused
    // we could use it to allow shadowing in same scope, e.g.
    //   "b = 4; b := true" where "b :=" redeclares b.

    if (p.tok == token.ASSIGN) {
      // e.g.  "a = 1"  "a, b = 1, 2"  "a[1], b.f = 1, 2"  etc
      return p.assignment(lhs)
    }

    if (p.tok == token.NAME && lhs.every(x => x instanceof Ident)) {
      // var definition
      // e.g. "a T", "a, b, c T" -- declare var with type T

      // first, revert either bindings or unresolved mark of LHS idents
      for (let i = 0; i < lhs.length; i++) {
        let x = lhs[i] as Ident
        if (x.ent) {
          x.unrefEnt()
        } else {
          assert(p.unresolved != null)
          ;(p.unresolved as Set<Ident>).delete(x)
        }
      }

      // now, form a var declaration (next up may be assignment and values)
      return p.varDecl(lhs[0].pos, lhs as Ident[])
    }

    const pos = lhs[0].pos

    if (lhs.length != 1) {
      p.syntaxError('expecting "=" or ","')
      p.advanceUntil(token.SEMICOLON, token.RBRACE)
      return lhs[0]
    }

    // single expression

    let t = p.types.resolve(lhs[0])

    if (token.assignop_beg < p.tok && p.tok < token.assignop_end) {
      // lhs op= rhs;  e.g. "x += 2"
      let op = p.tok
      p.next() // consume operator
      p.checkBasicTypeMutation(lhs[0], t)

      // map assign ops to regular ops.
      // e.g. "(assign += x 2)" => "(assign + x 2)"
      switch (op) {
        case token.ADD_ASSIGN:     op = token.ADD; break  // +
        case token.SUB_ASSIGN:     op = token.SUB; break  // -
        case token.MUL_ASSIGN:     op = token.MUL; break  // *
        case token.QUO_ASSIGN:     op = token.QUO; break  // /
        case token.REM_ASSIGN:     op = token.REM; break  // %
        case token.AND_ASSIGN:     op = token.AND; break  // &
        case token.OR_ASSIGN:      op = token.OR;  break  // |
        case token.XOR_ASSIGN:     op = token.XOR; break  // ^
        case token.SHL_ASSIGN:     op = token.SHL; break  // <<
        case token.SHR_ASSIGN:     op = token.SHR; break  // >>
        case token.AND_NOT_ASSIGN: op = token.AND_NOT; break // &^
        default:
          assert(false, `unexpected operator token ${token[op]}`)
      }

      const s = new Assignment(pos, p.scope, op, lhs, [])
      s.rhs = p.exprList(/*ctx=*/s)
      p.types.resolve(s)
      return s
    }

    if (p.tok == token.INC || p.tok == token.DEC) {
      // lhs++ or lhs--
      const op = p.tok
      p.next() // consume operator
      p.checkBasicTypeMutation(lhs[0], t)
      let s = new Assignment(pos, p.scope, op, lhs, emptyExprList)
      p.types.resolve(s)
      return s
    }

    if (p.tok == token.ARROWL) {
      // lhs <- rhs
      p.syntaxError("TODO simpleStmt ARROWL")
    }

    if (p.tok == token.ARROWR) {
      // params -> result
      p.syntaxError("TODO simpleStmt ARROWR")
    }

    // else: expr
    return lhs[0]
  }


  checkBasicTypeMutation(x :Expr, t :Type) {
    if (!(t instanceof IntType) &&
      t !== u_t_f32 && t !== u_t_f64 &&
      !(t instanceof UnresolvedType)
    ) {
      // dlog(`operand type: ${x.constructor.name}`, x)
      this.syntaxError(`cannot mutate ${x}`, x.pos)
    }
  }


  maybeStmt() :Stmt|null {
    // Statement =
    //   Declaration | LabeledStmt | simpleStmt |
    //   GoStmt | ReturnStmt | BreakStmt | ContinueStmt | GotoStmt |
    //   FallthroughStmt | Block | IfExpr | SwitchStmt | SelectStmt | ForStmt |
    //   DeferStmt .
    const p = this

    switch (p.tok) {
      // Most statements (assignments) start with an identifier;
      // look for it first before doing anything more expensive.
      case token.NAME:
      case token.NAMEAT:
        return p.simpleStmt(p.exprList(/*ctx=*/null))

      case token.LBRACE:
        p.pushScope()
        const s = p.block()
        p.popScope()
        return s

      case token.TYPE:
        return p.multiDecl(p.typeDecl)

      case token.ADD:
      case token.SUB:
      case token.MUL:
      case token.AND:
      case token.NOT:
      case token.XOR: // unary operators
      case token.FUN:
      case token.LPAREN: // operands
      case token.LBRACKET:
      // case token.STRUCT:
      // case token.CHAN:
      case token.INTERFACE: // composite types
      // case token.ARROW: // receive operator
        return p.simpleStmt(p.exprList(/*ctx=*/null))

      // case token.FOR:
      //   return p.forStmt()

      // case token.SWITCH:
      //   return p.switchStmt()

      // case token.SELECT:
      //   return p.selectStmt()

      case token.WHILE:
        return p.whileStmt()

      case token.IF:
        return p.ifExpr(/*ctx=*/null)

      // case token.FALLTHROUGH:
      //   s := new(BranchStmt)
      //   s.pos = p.pos()
      //   p.next()
      //   s.Tok = _Fallthrough
      //   return s

      // case token.BREAK, token.CONTINUE:
      //   s := new(BranchStmt)
      //   s.pos = p.pos()
      //   s.Tok = p.tok
      //   p.next()
      //   if p.tok == _Name {
      //     s.Label = p.name()
      //   }
      //   return s

      // case token.GO, token.DEFER:
      //   return p.callStmt()

      // case token.GOTO:
      //   s := new(BranchStmt)
      //   s.pos = p.pos()
      //   s.Tok = _Goto
      //   p.next()
      //   s.Label = p.name()
      //   return s

      case token.RETURN:
        return p.returnStmt()

      // case token.SEMI:
      //   s := new(EmptyStmt)
      //   s.pos = p.pos()
      //   return s

      default:
        if (token.literal_beg < p.tok && p.tok < token.literal_end) {
          return p.simpleStmt(p.exprList(/*ctx=*/null))
        }
    }

    return null
  }

  whileStmt() :WhileStmt {
    //
    // WhileStmt = "while" Expression Block
    //
    const p = this
    const pos = p.pos
    const scope = p.scope

    p.want(token.WHILE)

    const cond = p.expr(/*ctx=*/null)
    p.types.resolve(cond)

    const body = p.expr(/*ctx=*/null)

    return new WhileStmt(pos, scope, cond, body)
  }

  ifExpr(ctx :exprCtx) :IfExpr {
    //
    // IfExpr = "if" Expression Block
    //          [ "else" ( IfExpr | Block ) ]
    //
    // e.g. `if x > 1 "large" else "small"`
    // e.g. `if x = size() > 1 print("large number: $x")`
    //
    const p = this

    // push a scope for conditions to support e.g. capture of x in
    //   if x = a() > 0 print("$x > 0") else print("$x < 0")
    //
    p.pushScope()
    const s = p.ifExpr2(ctx)
    p.popScope()

    return s
  }

  ifExpr2(ctx :exprCtx) :IfExpr {
    // used by ifExpr
    const p = this
    const pos = p.pos
    const scope = p.scope

    p.want(token.IF)

    const cond = p.expr(ctx)
    p.types.resolve(cond)

    const then = p.expr(ctx)

    const s = new IfExpr(pos, scope, cond, then, null)

    if (p.got(token.ELSE)) {
      if (p.tok == token.IF) {
        s.els_ = p.ifExpr2(ctx)
      } else {
        p.pushScope()
        s.els_ = p.expr(ctx)
        p.popScope()
      }
    }

    return s
  }

  returnStmt() :ReturnStmt {
    const p = this
    const pos = p.pos

    p.want(token.RETURN)

    // expected return type (may be u_t_auto; u_t_nil/u_t_void for init)
    const fi = p.currFun()
    const frtype = fi.f.sig.result as Type  // ok; already resolved
    assert(frtype instanceof Type, "currFun sig.result type not resolved")

    const n = new ReturnStmt(pos, p.scope, u_t_nil, frtype)

    if (p.tok == token.SEMICOLON || p.tok == token.RBRACE) {
      // no result; just "return"
      if (frtype !== u_t_nil/*u_t_void*/) {
        if (frtype === u_t_auto && fi.autort == null) {
          // if `fi.autort != null` that means the block returns both
          // some type and nothing, which is invalid.
          fi.f.sig.result = u_t_nil //u_t_void
        } else {
          p.syntaxError(
            `missing return value; expecting ${fi.autort || frtype}`
          )
        }
      }
      return n
    }

    // expecting one or more results to follow
    
    const xs = p.exprList(/*ctx=*/null) // ?: maybe pass TupleExpr?
    
    let rval = (
      xs.length == 1 ? xs[0] :
        // e.g. "return 1", "return (1, 2)"

      new TupleExpr(xs[0].pos, xs[0].scope, xs)
        // Support paren-less tuple return
        // e.g. "return 1, 2" == "return (1, 2)"
    )

    if (frtype === u_t_nil/*u_t_void*/) {
      p.syntaxError("function does not return a value", rval.pos)
      return n
    }

    const rtype = p.types.resolve(rval)

    if (frtype === u_t_auto) {
      // register inferred result type
      fi.addInferredReturnType(rtype)
    } else if (!(rtype instanceof UnresolvedType) && !frtype.equals(rtype)) {
      // attempt type conversion
      const convres = p.types.convert(frtype, rval)
      if (convres) {
        rval = convres
      } else {
        // error: type mismatch
        p.syntaxError(
          (rval.type instanceof UnresolvedType ?
            `cannot use "${rval}" as return type ${frtype}` :
            `cannot use "${rval}" (type ${rval.type}) as return type ${frtype}`
          ),
          rval.pos
        )
      }
    }

    n.result = rval

    return n
  }

  exprList(ctx :exprCtx) :Expr[] {
    // ExpressionList = Expression ( "," Expression )*
    const p = this
    const list = [p.expr(ctx)]
    while (p.got(token.COMMA)) {
      list.push(p.expr(ctx))
    }
    return list
  }

  expr(ctx :exprCtx) :Expr {
    const p = this
    return p.binaryExpr(prec.LOWEST, ctx)
  }

  binaryExpr(pr :prec, ctx :exprCtx) :Expr {
    // Expression = UnaryExpr | Expression binary_op Expression
    const p = this
    let x = p.unaryExpr(ctx)

    while (
      (token.operator_beg < p.tok && p.tok < token.operator_end) &&
      p.prec > pr)
    {
      const pos = p.pos
      const tprec = p.prec
      const op = p.tok
      p.next()
      x = new Operation(pos, p.scope, op, x, p.binaryExpr(tprec, ctx))

      p.types.resolve(x)
      // Note: We need to resolve types here rather than outside this
      // loop since x may be an identifier in the left-hand-side of an
      // assignment operation, which would cause type resolution to fail,
      // which is slow.
    }

    return x
  }

  unaryExpr(ctx :exprCtx) :Expr {
    // UnaryExpr = PrimaryExpr | unary_op UnaryExpr
    const p = this
    const t = p.tok
    const pos = p.pos

    switch (t) {
      case token.ADD:
      case token.SUB:
      case token.NOT:
      case token.XOR: {
        p.next()
        // unaryExpr may have returned a parenthesized composite literal
        // (see comment in operand)
        let x = new Operation(pos, p.scope, t, p.unaryExpr(ctx))
        p.types.resolve(x)

        let isint = x.type instanceof IntType
        if (!isint && t != token.ADD && t != token.SUB) {
          p.syntaxError(
            `invalid operation ${tokstr(t)} ${p.types.resolve(x.x)}`
          )
        }

        return x
        // legacy: unparen(p.unaryExpr(ctx)) to unwrap ParenExpr.
      }

      // TODO: case token.ARROWL; `<-x`, `<-chan E`
    }

    return p.primExpr(ctx)
  }


  primExpr(ctx :exprCtx) :Expr {
    // PrimaryExpr =
    //   Operand |
    //   Conversion |
    //   PrimaryExpr Selector |
    //   PrimaryExpr Index |
    //   PrimaryExpr Slice |
    //   PrimaryExpr TypeAssertion |
    //   PrimaryExpr Arguments .
    //
    // Selector       = "." identifier .
    // Index          = "[" Expression "]" .
    // Slice          = "[" ( [ Expression ] ":" [ Expression ] ) |
    //                      ( [ Expression ] ":" Expression ":" Expression )
    //                  "]" .
    // TypeAssertion  = "." "(" Type ")" .
    // Arguments      = "("
    //   [ (  ExpressionList | Type [ "," ExpressionList ] ) [ "..." ] [ "," ]]
    //   ")" .
    const p = this
    let x = p.operand(ctx)

    loop:
    while (true) switch (p.tok) {

      case token.LPAREN:
        x = p.call(x, ctx)
        break  // may be more calls, e.g. foo()()()

      case token.LBRACKET:
        x = p.bracketExpr(x, ctx)
        break

      case token.DOT:
        x = p.selectorExpr(x, ctx)
        break

      default:
        break loop
    }

    return x
  }


  call(fun :Expr, ctx :exprCtx) :CallExpr {
    // Arguments = "(" [
    //     ( ExpressionList | Type [ "," ExpressionList ] )
    //     [ "..." ] [ "," ]
    //   ] ")"
    const p = this

    // call or conversion
    // convtype '(' expr ocomma ')'
    const pos = p.pos
    const args = [] as Expr[]
    let hasDots = false

    p.want(token.LPAREN)
    // p.xnest++

    while (p.tok != token.EOF && p.tok != token.RPAREN) {
      args.push(p.expr(ctx))
      hasDots = p.got(token.ELLIPSIS)
      if (!p.ocomma(token.RPAREN) || hasDots) {
        break
      }
    }

    // p.xnest--
    p.want(token.RPAREN)

    return new CallExpr(pos, p.scope, fun, args, hasDots)
  }


  operand(ctx :exprCtx) :Expr {
    // Operand   = Literal | OperandName | MethodExpr | "(" Expression ")" .
    // Literal   = NumLit | string_lit | CompositeLit | FunctionLit .
    // NumLit    = int_lit | float_lit | ratio_lit | rune_lit
    // OperandName = identifier | QualifiedIdent.
    const p = this

    switch (p.tok) {
      case token.NAME:
      case token.NAMEAT:
        return p.dotident(ctx, p.resolve(p.ident()))

      case token.LPAREN:
        return p.parenExpr(ctx)

      case token.FUN:
        return p.funExpr(ctx)

      case token.LBRACE:
        p.pushScope()
        const b = p.block()
        p.popScope()
        return b

      case token.IF:
        return p.ifExpr(ctx)

      // case _Lbrack, _Chan, _Map, _Struct, _Interface:
      //   return p.type_() // othertype

      case token.STRING:
        return p.strlit()

      default: {
        if (
          token.literal_basic_beg < p.tok &&
          p.tok < token.literal_basic_end
        ) {
          return p.numLit(ctx)
        }

        const x = p.bad()
        p.syntaxError("expecting expression")
        // p.next()
        return x
      }
    }
  }


  numLit(ctx :exprCtx) :NumLit {
    //
    // NumLit  = int_lit | float_lit | ratio_lit | rune_lit
    //
    const p = this
    const x = new NumLit(p.pos, p.scope, p.tok, 0, u_t_i32)

    // pick type best suited for value
    switch (p.tok) {
      case token.INT:
      case token.INT_BIN:
      case token.INT_OCT:
      case token.INT_HEX:
        // prefer signed integer types when the value fits
        if (p.int64val) {
          if (p.int64val.isSigned || p.int64val.lte(SInt64.MAX)) {
            x.value = p.int64val.toSigned()
            x.type = u_t_i64
          } else {
            assert(p.int64val instanceof UInt64)
            x.value = p.int64val
            x.type = u_t_u64
          }
        } else {
          x.value = p.int32val
          x.type = x.value <= 0x7fffffff ? u_t_i32 : u_t_u32
        }
        break
      
      case token.FLOAT:
        x.value = p.floatval
        x.type = u_t_f64
        break
      
      case token.CHAR:
        x.value = p.int32val
        x.type = u_t_u32
        assert(x.value >= 0, 'negative character value')
        break
    }

    assert(typeof x.value == 'number' ? !isNaN(x.value) : true)

    // a certain type was requested
    const reqt = p.ctxType(ctx) as NumType | null
    if (reqt) {
      if (!(reqt instanceof NumType)) {
        p.syntaxError(`invalid value ${x.value} for type ${reqt}`)
      } else {
        // capture refs to current type and value before converting, as
        // convertToType may change these properties.
        let xt = x.type
        let xv = x.value
        if (!x.convertToType(reqt)) {
          let tIsInt = xt instanceof IntType
          let reqtIsInt = reqt instanceof IntType
          if (tIsInt == reqtIsInt) {
            p.syntaxError(`constant ${xv} overflows ${reqt.name}`)
          } else {
            p.syntaxError(`constant ${xv} truncated to ${reqt.name}`)
          }
        }
      }
    }

    p.next() // consume literal token

    return x
  }


  numLitErrH = (msg :string, pos :Pos) => {
    this.syntaxError(msg, pos)
  }


  strlit() :StringLit {
    const p = this
    assert(p.tok == token.STRING)
    const n = new StringLit(p.pos, p.scope, p.takeByteValue())
    n.type = new StrType(n.value.length)
    p.next()
    return n
  }


  selectorExpr(operand :Expr, ctx :exprCtx) :SelectorExpr|IndexExpr {
    // SelectorExpr = Expr "." ( Ident | IntLit )
    const p = this
    p.want(token.DOT)
    const pos = p.pos  // pos is after "."

    let rhs :Expr
    if (p.tok as token == token.NAME) {
      // e.g. "a.b"
      rhs = p.dotident(ctx, p.ident())

    } else if (
      (p.tok as token) > token.literal_int_beg &&
      (p.tok as token) < token.literal_int_end
    ) {
      // e.g. "t.3"
      let x = new IndexExpr(pos, p.scope, operand, p.numLit(ctx))
      if (operand.type instanceof TupleType) {
        if (!p.types.tupleAccess(x)) {
          x.type = p.types.markUnresolved(x)
        }
      } else {
        // numeric access on something that's not a tuple
        x.type = p.types.markUnresolved(x)
        p.syntaxError(
          `numeric field access on non-tuple type ${operand.type}`,
          pos
        )
      }
      return x

    } else {
      p.syntaxError('expecting name or integer after "."')
      rhs = p.bad(pos)
    }

    return new SelectorExpr(pos, p.scope, operand, rhs)
  }


  dotident(ctx :exprCtx, ident :Ident) :Ident|SelectorExpr|IndexExpr {
    // dotident = Ident | SelectorExpr
    const p = this
    return p.tok == token.DOT ? p.selectorExpr(ident, ctx) : ident
  }


  bracketExpr(operand :Expr, ctx :exprCtx) :IndexExpr|SliceExpr {
    // bracketExpr = IndexExpr | SliceExpr
    // IndexExpr   = Expr "[" Expr "]"
    // SliceExpr   = Expr "[" Expr? ":" Expr? "]"
    const p = this
    const pos = p.pos
    p.want(token.LBRACKET)

    let x1 :Expr|null = null
    if (p.tok != token.COLON) {
      x1 = p.expr(ctx)
    }

    if (p.got(token.COLON)) {
      // slice, e.g. "x[1:3]", "x[:3]", "x[1:]", "x[:]"
      let endx :Expr|null = null
      
      if (!p.got(token.RBRACKET)) {
        // explicit end, e.g. "x[1:3]", "x[:3]
        endx = p.expr(ctx)
        p.want(token.RBRACKET)
      } // else: implicit end, e.g. "x[1:]", "x[:]"

      let x = new SliceExpr(pos, p.scope, operand, x1, endx)

      if (operand.type instanceof TupleType) {
        // non-uniform operand type
        // we need to resolve indexes to find type
        if (!p.types.tupleSlice(x)) {
          x.type = p.types.markUnresolved(x)
        }
      } else dlog(`TODO handle uniform slice operand ${operand.type}`)

      return x
    }

    // index
    p.want(token.RBRACKET)
    
    assert(x1 != null)
    assert(x1 instanceof Expr)

    let x = new IndexExpr(pos, p.scope, operand, x1 as Expr)

    if (operand.type instanceof TupleType) {
      // non-uniform operand type
      // we need to resolve index to find type
      if (!p.types.tupleAccess(x)) {
        x.type = p.types.markUnresolved(x)
      }
      return x
    }

    // else: operand is unitype or unknown
    dlog(`TODO resolve item type for uniform operand of type ${operand.type}`)
    x.type = p.types.markUnresolved(x)
    return x
    // return p.types.resolveIndex(x)
  }


  parenExpr(ctx :exprCtx) :Expr {
    // ParenExpr = "(" Expr ","? ")" | TupleExpr | Assignment
    // TupleExpr = "(" Expr ("," Expr)+ ","? ")"
    const p = this
    const pos = p.pos
    p.want(token.LPAREN)

    const l = []
    while (true) {
      l.push(p.expr(ctx))
      if (p.tok == token.ASSIGN) {
        // e.g. "(a, b = 1, 2)"
        const x = p.assignment(l)
        p.want(token.RPAREN)
        return x
      }
      if (!p.ocomma(token.RPAREN)) {
        break  // error: unexpected ;, expecting comma, or )
      }
      if (p.tok == token.RPAREN) {
        break
      }
    }
    p.want(token.RPAREN)

    return (
      // l.length == 1 ? (
      //   p.keepParens ? new ParenExpr(pos, p.scope, l[0]) :
      //   l[0]
      // ) :
      l.length == 1 ? l[0] :
      new TupleExpr(pos, p.scope, l)
    )
  }


  bad(pos? :Pos) :BadExpr {
    const p = this
    return new BadExpr(pos === undefined ? p.pos : pos, p.scope)
  }


  // maybeType is like type but it returns null if there was no type
  // instead of reporting an error.
  //
  // Type     = TypeName | TypeLit | "(" Type ")" .
  // TypeName = identifier | QualifiedIdent .
  // TypeLit  = ArrayType | StructType | PointerType | FunctionType
  //          | InterfaceType | SliceType | MapType | Channel_Type
  maybeType() :Expr|null {
    const p = this
    let x :Expr|null = null

    switch (p.tok) {

      // TODO: all other types

      case token.NAME:
        x = p.dotident(null, p.resolve(p.ident()))
        break

      case token.LPAREN:
        const t = p.tupleType()
        x = (
          t.exprs.length == 0 ? null :        // "()"  => null
          t.exprs.length == 1 ? t.exprs[0] :  // "(a)" => "a"
          t                                   // "(a, b)"
        )
        break

      default:
        return null
    }

    return x && p.types.resolve(x) || null
  }

  type() :Expr {
    const p = this
    let t = p.maybeType()
    if (!t) {
      t = p.bad()
      p.syntaxError("expecting type")
      p.next()
    }
    return t
  }

  tupleType() :TupleExpr {
    // TupleType = "(" Type ("," Type)+ ","? ")"
    const p = this
    p.want(token.LPAREN)
    const pos = p.pos
    const l = []
    while (p.tok != token.RPAREN) {
      l.push(p.type())
      if (!p.ocomma(token.RPAREN)) {
        // error: unexpected ;, expecting comma, or )
        break
      }
    }
    p.want(token.RPAREN)
    return new TupleExpr(pos, p.scope, l)
  }

  // IdentifierList = identifier { "," identifier } .
  // The first identifier must be provided.
  identList(first :Ident) :Ident[] {
    const p = this
    const l = [first]
    while (p.got(token.COMMA)) {
      l.push(p.ident())
    }
    return l
  }

  ident() :Ident {
    const p = this
    const pos = p.pos
    if (p.tok == token.NAME) {
      const s = p.strSet.emplace(p.takeByteValue(), p.hash)
      p.next()
      return new Ident(pos, p.scope, s)
    }
    p.syntaxError("expecting identifier", pos)
    p.advanceUntil()
    return new Ident(pos, p.scope, p._id__)
  }

  maybeIdent() :Ident|null {
    const p = this
    return (p.tok == token.NAME) ? p.ident() : null
  }

  fallbackIdent(pos? :Pos) :Ident {
    const p = this
    return new Ident(pos === undefined ? p.pos : pos, p.scope, p._id__)
  }

  // osemi parses an optional semicolon.
  osemi(follow :token) :bool {
    const p = this

    switch (p.tok) {
      case token.SEMICOLON:
        p.next()
        return true
    
      case token.RPAREN:
      case token.RBRACE:
        // semicolon is optional before ) or }
        return true
    }
  
    p.syntaxError("expecting semicolon, newline, or " + tokstr(follow))
    p.advanceUntil(follow)
    return false
  }

  // ocomma parses an optional comma.
  ocomma(follow :token) :bool {
    const p = this

    switch (p.tok) {
      case token.COMMA:
        p.next()
        return true

      case token.RPAREN:
      case token.RBRACE:
        // comma is optional before ) or }
        return true
    }

    p.syntaxError("expecting comma, or " + tokstr(follow))
    p.advanceUntil(follow)
    return false
  }

  // appendGroup(f) = f | "(" { f ";" } ")" .
  appendGroup<D extends Decl>(list :D[], f :(g:Group|null, i:int)=>D) {
    const p = this
    let i = 0
    if (p.got(token.LPAREN)) {
      const g = new Group()
      while (p.tok != token.EOF && p.tok != token.RPAREN) {
        list.push(f(g, i++))
        if (!p.osemi(token.RPAREN)) {
          break
        }
      }
      p.want(token.RPAREN)
    } else {
      list.push(f(null, i))
    }
  }

  // advanceUntil consumes tokens until it finds a token of the followlist.
  // The stopset is only considered if we are inside a function (p.fnest > 0).
  // The followlist is the list of valid tokens that can follow a production;
  // if it is empty, exactly one token is consumed to ensure progress.
  //
  // Not speed critical, advance is only called in error situations.
  //
  advanceUntil(...followlist :token[]) {
    const p = this

    if (followlist.length == 0) {
      p.next()
      return
    }

    // TODO: improve performance of this, especially followlist.includes

    if (p.fnest > 0) {
      // The stopset contains keywords that start a statement.
      // They are good synchronization points in case of syntax
      // errors and (usually) shouldn't be skipped over.
      loop1:
      while (!followlist.includes(p.tok)) {
        switch (p.tok) {
          case token.EOF:
          case token.BREAK:
          // case token.CONST:
          case token.CONTINUE:
          case token.DEFER:
          case token.FALLTHROUGH:
          case token.FOR:
          case token.FUN:
          case token.GO:
          // case token.GOTO:
          case token.IF:
          case token.RETURN:
          case token.SELECT:
          case token.SWITCH:
          case token.TYPE:
            break loop1
        }
        p.next()
      }
    } else {
      while (!(p.tok == token.EOF || followlist.includes(p.tok))) {
        p.next()
      }
    }
  }

  // syntaxError reports a syntax error
  //
  syntaxError(msg :string, pos :Pos = this.pos) {
    const p = this
    const position = p.sfile.position(pos)

    // if (p.tok == token.EOF) {
    //   return // avoid meaningless follow-up errors
    // }

    // add punctuation etc. as needed to msg
    if (msg == "") {
      // nothing to do
    } else if (
      msg.startsWith("in ") ||
      msg.startsWith("at ") ||
      msg.startsWith("after "))
    {
      msg = " " + msg
    } else if (msg.startsWith("expecting ")) {
      msg = ", " + msg
    } else {
      // plain error - we don't care about current token
      p.errorAt(msg, position)
      return
    }

    let cond = (
      p.tok == token.EOF ? 'unexpected end of input' :
      `unexpected ${tokstr(p.tok)}`
    )
    p.errorAt(cond + msg, position)
    if (DEBUG) {
      // print token state when compiled in debug mode
      console.error(`  p.tok = ${token[p.tok]} ${tokstr(p.tok)}`)
    }
  }

  // diag reports a diagnostic message, or an error if k is ERROR
  //
  diag(k :DiagKind, msg :string, pos :Pos = this.pos, code? :ErrorCode) {
    const p = this
    // if (code !== undefined) {
    //   // level overridden?
    //   k = p.diagConfig[code] || k
    // }
    if (k == "error") {
      p.error(msg, pos, code)
    } else if (p.diagh) {
      p.diagh(p.sfile.position(pos), msg, k)
    }
  }

}

// unparen removes all parentheses around an expression.
// function unparen(x :Expr) :Expr {
//   while (x instanceof ParenExpr) {
//     x = x.x
//   }
//   return x
// }

function isEmptyFunExpr(d :Decl) :bool {
  return d instanceof FunExpr && !d.body
}
