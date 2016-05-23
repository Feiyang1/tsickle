import * as ts from 'typescript';
import {TypeTranslator} from './type-translator';
import {Rewriter} from './rewriter';
export {convertDecorators} from './decorator-annotator';

export interface Options {
  // If true, convert every type to the Closure {?} type, which means
  // "don't check types".
  untyped?: boolean;
  // If provided a function that logs an internal warning.
  // These warnings are not actionable by an end user and should be hidden
  // by default.
  logWarning?: (warning: ts.Diagnostic) => void;
}

export interface Output {
  // The TypeScript source with Closure annotations inserted.
  output: string;
  // Generated externs declarations, if any.
  externs: string;
  // Error messages, if any.
  diagnostics: ts.Diagnostic[];
}

/**
 * Symbols that are already declared as externs in Closure, that should
 * be avoided by tsickle's "declare ..." => externs.js conversion.
 */
export let closureExternsBlacklist: string[] = [
  'exports',
  'global',
  'module',
  'WorkerGlobalScope',
  'Symbol',
];

export function formatDiagnostics(diags: ts.Diagnostic[]): string {
  return diags
      .map((d) => {
        let res = ts.DiagnosticCategory[d.category];
        if (d.file) {
          res += ' at ' + d.file.fileName + ':';
          let {line, character} = d.file.getLineAndCharacterOfPosition(d.start);
          res += (line + 1) + ':' + (character + 1) + ':';
        }
        res += ' ' + ts.flattenDiagnosticMessageText(d.messageText, '\n');
        return res;
      })
      .join('\n');
}

/**
 * TypeScript has an API for JSDoc already, but it's not exposed.
 * https://github.com/Microsoft/TypeScript/issues/7393
 * For now we create types that are similar to theirs so that migrating
 * to their API will be easier.  See e.g. ts.JSDocTag and ts.JSDocComment.
 */
export interface JSDocTag {
  // tagName is e.g. "param" in an @param declaration.  It's absent
  // for the plain text documentation that occurs before any @foo lines.
  tagName?: string;
  // parameterName is the the name of the function parameter, e.g. "foo"
  // in
  //   @param foo The foo param.
  parameterName?: string;
  type?: string;
  // optional is true for optional function parameters.
  optional?: boolean;
  // restParam is true for "...x: foo[]" function parameters.
  restParam?: boolean;
  // destructuring is true for destructuring bind parameters, which require
  // non-null arguments on the Closure side.  Can likely remove this
  // once TypeScript nullable types are available.
  destructuring?: boolean;
  text?: string;
}

export interface JSDocComment { tags: JSDocTag[]; }

/**
 * getJSDocAnnotation parses JSDoc out of a comment string.
 * Returns null if comment is not JSDoc.
 */
export function getJSDocAnnotation(comment: string): JSDocComment {
  // TODO(evanm): this is a pile of hacky regexes for now, because we
  // would rather use the better TypeScript implementation of JSDoc
  // parsing.  https://github.com/Microsoft/TypeScript/issues/7393
  let match = comment.match(/^\/\*\*([\s\S]*?)\*\/$/);
  if (!match) return null;
  comment = match[1].trim();
  // Strip all the " * " bits from the front of each line.
  comment = comment.replace(/^\s*\* /gm, '');
  let lines = comment.split('\n');
  let tags: JSDocTag[] = [];
  for (let line of lines) {
    match = line.match(/^@(\S+) *(.*)/);
    if (match) {
      let [_, tagName, text] = match;
      if (tagName === 'type') {
        throw new Error('@type annotations are not allowed');
      }
      if ((tagName === 'param' || tagName === 'return') && text[0] === '{') {
        throw new Error('type annotations (using {...}) are not allowed');
      }

      // Grab the parameter name from @param tags.
      let parameterName: string;
      if (tagName === 'param') {
        match = text.match(/^(\S+) ?(.*)/);
        if (match) [_, parameterName, text] = match;
      }

      let tag: JSDocTag = {tagName};
      if (parameterName) tag.parameterName = parameterName;
      if (text) tag.text = text;
      tags.push(tag);
    } else {
      // Text without a preceding @tag on it is either the plain text
      // documentation or a continuation of a previous tag.
      if (tags.length === 0) {
        tags.push({text: line.trim()});
      } else {
        tags[tags.length - 1].text += ' ' + line.trim();
      }
    }
  }
  return {tags};
}

function getIdentifierText(identifier: ts.Identifier): string {
  // NOTE: the 'text' property on an Identifier may be escaped if it starts
  // with '__', so just use getText().
  return identifier.getText();
}

/**
 * Converts an escaped TypeScript name into the original source name.
 * Prefer getIdentifierText() instead if possible.
 */
function unescapeName(name: string): string {
  // See the private function unescapeIdentifier in TypeScript's utilities.ts.
  if (name.match(/^___/)) return name.substr(1);
  return name;
}

const VISIBILITY_FLAGS = ts.NodeFlags.Private | ts.NodeFlags.Protected | ts.NodeFlags.Public;

/**
 * A source processor that takes TypeScript code and annotates the output with Closure-style JSDoc
 * comments.
 */
class Annotator extends Rewriter {
  /** Generated externs.js, if any. */
  private externsOutput: string[] = [];
  /** Exported symbol names that have been generated by expanding an "export * from ...". */
  private generatedExports: {[symbol: string]: boolean} = {};
  /** The set of namespaces that have already been emitted (through classes or modules). */
  private emittedNamespaces: ts.Map<boolean> = {};

  constructor(private program: ts.Program, file: ts.SourceFile, private options: Options) {
    super(file);
  }

  annotate(): Output {
    this.visit(this.file);
    let externs: string = null;
    if (this.externsOutput.length > 0) {
      externs = '/** @externs */\n' + this.externsOutput.join('');
    }
    let {output, diagnostics} = this.getOutput();
    return {
      output,
      externs,
      diagnostics: diagnostics,
    };
  }

  /**
   * Examines a ts.Node and decides whether to do special processing of it for output.
   *
   * @return True if the ts.Node has been handled, false if we should
   *     emit it as is and visit its children.
   */
  maybeProcess(node: ts.Node): boolean {
    if (node.flags & ts.NodeFlags.Ambient) {
      this.visitExterns(node);
      // An ambient declaration declares types for TypeScript's benefit, so we want to skip Tsickle
      // conversion of its contents.
      this.writeRange(node.getFullStart(), node.getEnd());
      return true;
    }

    switch (node.kind) {
      case ts.SyntaxKind.ExportDeclaration:
        let exportDecl = <ts.ExportDeclaration>node;
        if (!exportDecl.exportClause && exportDecl.moduleSpecifier) {
          // It's an "export * from ..." statement.
          // Rewrite it to re-export each exported symbol directly.
          let exports = this.expandSymbolsFromExportStar(exportDecl);
          this.writeRange(exportDecl.getFullStart(), exportDecl.getStart());
          this.emit(`export {${exports.join(',')}} from`);
          this.writeRange(exportDecl.moduleSpecifier.getFullStart(), node.getEnd());
          return true;
        }
        return false;
      case ts.SyntaxKind.InterfaceDeclaration:
        this.emitInterface(node as ts.InterfaceDeclaration);
        // Emit the TS interface verbatim, with no tsickle processing of properties.
        this.writeRange(node.getFullStart(), node.getEnd());
        return true;
      case ts.SyntaxKind.VariableDeclaration:
        let varDecl = node as ts.VariableDeclaration;
        // Only emit a type annotation when it's a plain variable and
        // not a binding pattern, as Closure doesn't(?) have a syntax
        // for annotating binding patterns.  See issue #128.
        if (varDecl.name.kind === ts.SyntaxKind.Identifier) {
          this.emitJSDocType(varDecl);
        }
        return false;
      case ts.SyntaxKind.ClassDeclaration:
        let classNode = <ts.ClassDeclaration>node;
        if (classNode.members.length > 0) {
          // We must visit all members individually, to strip out any
          // /** @export */ annotations that show up in the constructor
          // and to annotate methods.
          this.writeRange(classNode.getFullStart(), classNode.members[0].getFullStart());
          for (let member of classNode.members) {
            this.visit(member);
          }
        } else {
          this.writeRange(classNode.getFullStart(), classNode.getLastToken().getFullStart());
        }
        this.emitTypeAnnotationsHelper(classNode);
        this.writeNode(classNode.getLastToken());
        return true;
      case ts.SyntaxKind.PublicKeyword:
      case ts.SyntaxKind.PrivateKeyword:
        // The "public"/"private" keywords are encountered in two places:
        // 1) In class fields (which don't appear in the transformed output).
        // 2) In "parameter properties", e.g.
        //      constructor(/** @export */ public foo: string).
        // In case 2 it's important to not emit that JSDoc in the generated
        // constructor, as this is illegal for Closure.  It's safe to just
        // always skip comments preceding the 'public' keyword.
        // See test_files/parameter_properties.ts.
        this.writeNode(node, /* skipComments */ true);
        return true;
      case ts.SyntaxKind.Constructor:
        let ctor = <ts.ConstructorDeclaration>node;
        this.emitFunctionType(ctor);
        // Write the "constructor(...) {" bit, but iterate through any
        // parameters if given so that we can examine them more closely.
        let offset = ctor.getStart();
        if (ctor.parameters.length) {
          for (let param of ctor.parameters) {
            this.writeRange(offset, param.getFullStart());
            this.visit(param);
            offset = param.getEnd();
          }
        }
        this.writeRange(offset, node.getEnd());
        return true;
      case ts.SyntaxKind.ArrowFunction:
        // It's difficult to annotate arrow functions due to a bug in
        // TypeScript (see tsickle issue 57).  For now, just pass them
        // through unannotated.
        return false;
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
        let fnDecl = <ts.FunctionLikeDeclaration>node;

        if (!fnDecl.body) {
          // Functions are allowed to not have bodies in the presence
          // of overloads.  It's not clear how to translate these overloads
          // into Closure types, so skip them for now.
          return false;
        }

        this.emitFunctionType(fnDecl);
        this.writeRange(fnDecl.getStart(), fnDecl.body.getFullStart());
        this.visit(fnDecl.body);
        return true;
      case ts.SyntaxKind.TypeAliasDeclaration:
        this.visitTypeAlias(<ts.TypeAliasDeclaration>node);
        this.writeNode(node);
        return true;
      case ts.SyntaxKind.EnumDeclaration:
        return this.maybeProcessEnum(<ts.EnumDeclaration>node);
      case ts.SyntaxKind.TypeAssertionExpression:
        let typeAssertion = <ts.TypeAssertion>node;
        this.emitJSDocType(typeAssertion);
        // When TypeScript emits JS, it removes one layer of "redundant"
        // parens, but we need them for the Closure type assertion.  Work
        // around this by using two parens.  See test_files/coerce.*.
        this.emit('((');
        this.writeNode(node);
        this.emit('))');
        return true;
      case ts.SyntaxKind.JsxText:
        // TypeScript seems to accidentally include one extra token of
        // text in each JSX text node as a child.  Avoid it here by just
        // emitting the node's text rather than visiting its children.
        // https://github.com/angular/tsickle/issues/76
        this.emit(node.getFullText());
        return true;
      default:
        break;
    }
    return false;
  }

  private expandSymbolsFromExportStar(exportDecl: ts.ExportDeclaration): string[] {
    let typeChecker = this.program.getTypeChecker();

    // Gather the names of local exports, to avoid reexporting any
    // names that are already locally exported.
    // To find symbols declared like
    //   export {foo} from ...
    // we must also query for "Alias", but that unfortunately also brings in
    //   import {foo} from ...
    // so the latter is filtered below.
    let locals =
        typeChecker.getSymbolsInScope(this.file, ts.SymbolFlags.Export | ts.SymbolFlags.Alias);
    let localSet: {[name: string]: boolean} = {};
    for (let local of locals) {
      if (local.declarations.some(d => d.kind === ts.SyntaxKind.ImportSpecifier)) {
        continue;
      }
      localSet[local.name] = true;
    }

    // Expand the export list, then filter it to the symbols we want
    // to reexport
    let exports =
        typeChecker.getExportsOfModule(typeChecker.getSymbolAtLocation(exportDecl.moduleSpecifier));
    let reexports: {[name: string]: boolean} = {};
    for (let sym of exports) {
      let name = sym.name;
      if (localSet.hasOwnProperty(name)) {
        // This name is shadowed by a local definition, such as:
        // - export var foo ...
        // - export {foo} from ...
        continue;
      }
      if (this.generatedExports.hasOwnProperty(name)) {
        // Already exported via an earlier expansion of an "export * from ...".
        continue;
      }
      this.generatedExports[name] = true;
      reexports[name] = true;
    }

    return Object.keys(reexports);
  }

  private emitFunctionType(fnDecl: ts.SignatureDeclaration, extraTags: JSDocTag[] = []) {
    let typeChecker = this.program.getTypeChecker();
    let sig = typeChecker.getSignatureFromDeclaration(fnDecl);

    // Construct the JSDoc comment by reading the existing JSDoc, if
    // any, and merging it with the known types of the function
    // parameters and return type.
    let jsDoc = this.getJSDoc(fnDecl) || {tags: []};
    let newDoc: JSDocComment = {tags: extraTags};

    // Copy all the tags other than @param/@return into the new
    // comment without any change; @param/@return are handled later.
    for (let tag of jsDoc.tags) {
      if (tag.tagName === 'param' || tag.tagName === 'return') continue;
      newDoc.tags.push(tag);
    }

    // Parameters.
    if (sig.parameters.length) {
      // Iterate through both the AST parameter list and the type's parameter
      // list, as some information is only available in the former.
      for (let i = 0; i < sig.parameters.length; i++) {
        let paramNode = fnDecl.parameters[i];
        let paramSym = sig.parameters[i];
        let type = typeChecker.getTypeOfSymbolAtLocation(paramSym, fnDecl);

        let newTag: JSDocTag = {
          tagName: 'param',
          optional: paramNode.initializer !== undefined || paramNode.questionToken !== undefined,
          parameterName: unescapeName(paramSym.getName()),
        };

        let destructuring =
            (paramNode.name.kind === ts.SyntaxKind.ArrayBindingPattern ||
             paramNode.name.kind === ts.SyntaxKind.ObjectBindingPattern);

        if (paramNode.dotDotDotToken !== undefined) {
          newTag.restParam = true;
          // In TypeScript you write "...x: number[]", but in Closure
          // you don't write the array: "@param {...number} x".  Unwrap
          // the Array<> wrapper.
          type = (type as ts.TypeReference).typeArguments[0];
        }

        newTag.type = this.typeToClosure(fnDecl, type, destructuring);

        // Search for this parameter in the JSDoc @params.
        for (let {tagName, parameterName, text} of jsDoc.tags) {
          if (tagName === 'param' && parameterName === newTag.parameterName) {
            newTag.text = text;
            break;
          }
        }
        newDoc.tags.push(newTag);
      }
    }

    // Return type.
    if (fnDecl.kind !== ts.SyntaxKind.Constructor) {
      let retType = typeChecker.getReturnTypeOfSignature(sig);
      let returnDoc: string;
      for (let {tagName, text} of jsDoc.tags) {
        if (tagName === 'return') {
          returnDoc = text;
          break;
        }
      }
      newDoc.tags.push({
        tagName: 'return',
        type: this.typeToClosure(fnDecl, retType),
        text: returnDoc,
      });
    }

    // The first \n makes the output sometimes uglier than necessary,
    // but it's needed to work around
    // https://github.com/Microsoft/TypeScript/issues/6982
    this.emit('\n/**\n');
    for (let tag of newDoc.tags) {
      this.emit(' * ');
      if (tag.tagName) {
        this.emit(`@${tag.tagName}`);
      }
      if (tag.type) {
        this.emit(' {');
        if (tag.restParam) {
          this.emit('...');
        }
        this.emit(tag.type);
        if (tag.optional) {
          this.emit('=');
        }
        this.emit('}');
      }
      if (tag.parameterName) {
        this.emit(' ' + tag.parameterName);
      }
      if (tag.text) {
        this.emit(' ' + tag.text);
      }
      this.emit('\n');
    }
    this.emit(' */\n');
  }

  private emitInterface(iface: ts.InterfaceDeclaration) {
    if (this.options.untyped) return;
    this.emit(`\n/** @record */\n`);
    this.emit(`function ${getIdentifierText(iface.name)}() {}\n`);
    if (iface.typeParameters) {
      this.emit(`// TODO: type parameters.\n`);
    }
    if (iface.heritageClauses) {
      this.emit(`// TODO: derived interfaces.\n`);
    }

    const memberNamespace = [getIdentifierText(iface.name), 'prototype'];
    for (let elem of iface.members) {
      this.visitProperty(memberNamespace, elem);
    }
  }

  // emitTypeAnnotationsHelper produces a
  // _tsickle_typeAnnotationsHelper() where none existed in the
  // original source.  It's necessary in the case where TypeScript
  // syntax specifies there are additional properties on the class,
  // because to declare these in Closure you must declare these in a
  // method somewhere.
  private emitTypeAnnotationsHelper(classDecl: ts.ClassDeclaration) {
    // Gather parameter properties from the constructor, if it exists.
    let ctors: ts.ConstructorDeclaration[] = [];
    let paramProps: ts.ParameterDeclaration[] = [];
    let nonStaticProps: ts.PropertyDeclaration[] = [];
    let staticProps: ts.PropertyDeclaration[] = [];
    for (let member of classDecl.members) {
      if (member.kind === ts.SyntaxKind.Constructor) {
        ctors.push(member as ts.ConstructorDeclaration);
      } else if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
        let prop = member as ts.PropertyDeclaration;
        let isStatic = (prop.flags & ts.NodeFlags.Static) !== 0;
        if (isStatic) {
          staticProps.push(prop);
        } else {
          nonStaticProps.push(prop);
        }
      }
    }

    if (ctors.length > 0) {
      let ctor = ctors[0];
      paramProps = ctor.parameters.filter((p) => !!(p.flags & VISIBILITY_FLAGS));
    }

    if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0) {
      // There are no members so we don't need to emit any type
      // annotations helper.
      return;
    }

    this.emit('\n\n  static _tsickle_typeAnnotationsHelper() {\n');
    staticProps.forEach(p => this.visitProperty([getIdentifierText(classDecl.name)], p));
    let memberNamespace = [getIdentifierText(classDecl.name), 'prototype'];
    nonStaticProps.forEach((p) => this.visitProperty(memberNamespace, p));
    paramProps.forEach((p) => this.visitProperty(memberNamespace, p));
    this.emit('  }\n');
  }

  private propertyName(prop: ts.Declaration): string {
    if (!prop.name) return null;

    switch (prop.name.kind) {
      case ts.SyntaxKind.Identifier:
        return getIdentifierText(prop.name as ts.Identifier);
      case ts.SyntaxKind.StringLiteral:
        // E.g. interface Foo { 'bar': number; }
        // If 'bar' is a name that is not valid in Closure then there's nothing we can do.
        return (prop.name as ts.StringLiteral).text;
      default:
        return null;
    }
  }

  private visitProperty(namespace: string[], p: ts.Declaration) {
    let name = this.propertyName(p);
    if (!name) {
      this.emit(`/* TODO: handle strange member:\n${this.escapeForComment(p.getText())}\n*/\n`);
      return;
    }

    let jsDoc = this.getJSDoc(p) || {tags: []};
    let existingAnnotation = '';
    for (let {tagName, text} of jsDoc.tags) {
      if (tagName) {
        existingAnnotation += `@${tagName}\n`;
      } else {
        existingAnnotation += `${text}\n`;
      }
    }
    this.emit(' /**');
    if (existingAnnotation) {
      this.emit(' ' + existingAnnotation);
    }
    this.emit(` @type {${this.typeToClosure(p)}} */\n`);
    namespace = namespace.concat([name]);
    this.emit(`${namespace.join('.')};\n`);
  }

  /**
   * Returns null if there is no existing comment.
   */
  private getJSDoc(node: ts.Node): JSDocComment {
    let text = node.getFullText();
    let comments = ts.getLeadingCommentRanges(text, 0);

    if (!comments || comments.length === 0) return null;

    // JS compiler only considers the last comment significant.
    let {pos, end} = comments[comments.length - 1];
    let comment = text.substring(pos, end);
    try {
      return getJSDocAnnotation(comment);
    } catch (e) {
      this.error(node, e.message, node.getFullStart() + pos);
      return null;
    }
  }

  private visitExterns(node: ts.Node, namespace: string[] = []) {
    let originalOutput = this.output;
    this.output = this.externsOutput;
    switch (node.kind) {
      case ts.SyntaxKind.ModuleDeclaration:
        let decl = <ts.ModuleDeclaration>node;
        switch (decl.name.kind) {
          case ts.SyntaxKind.Identifier:
            // E.g. "declare namespace foo {"
            let name: string;
            switch (decl.name.kind) {
              case ts.SyntaxKind.Identifier:
                name = getIdentifierText(decl.name as ts.Identifier);
                break;
              case ts.SyntaxKind.StringLiteral:
                name = (decl.name as ts.StringLiteral).text;
                break;
              default:
                this.errorUnimplementedKind(decl.name, 'namespace name');
                break;
            }
            namespace = namespace.concat(name);
            let nsName = namespace.join('.');
            if (!this.emittedNamespaces.hasOwnProperty(nsName)) {
              this.emit('/** @const */\n');
              if (namespace.length > 1) {
                this.emit(`${namespace.join('.')} = {};\n`);
              } else {
                this.emit(`var ${namespace} = {};\n`);
              }
            }
            this.emittedNamespaces[nsName] = true;
            this.visitExterns(decl.body, namespace);
            break;
          case ts.SyntaxKind.StringLiteral:
            // E.g. "declare module 'foo' {" (note the quotes).
            // Skip it.
            break;
          default:
            this.errorUnimplementedKind(decl.name, 'externs generation of namespace');
        }
        break;
      case ts.SyntaxKind.ModuleBlock:
        let block = <ts.ModuleBlock>node;
        for (let stmt of block.statements) {
          this.visitExterns(stmt, namespace);
        }
        break;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        this.writeExternsType(<ts.InterfaceDeclaration|ts.ClassDeclaration>node, namespace);
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        let f = <ts.FunctionDeclaration>node;
        this.emitFunctionType(f);
        let params = f.parameters.map((p) => p.name.getText());
        this.writeExternsFunction(f.name.getText(), params.join(', '), namespace);
        break;
      case ts.SyntaxKind.VariableStatement:
        for (let decl of (<ts.VariableStatement>node).declarationList.declarations) {
          this.writeExternsVariable(decl, namespace);
        }
        break;
      case ts.SyntaxKind.EnumDeclaration:
        this.writeExternsEnum(node as ts.EnumDeclaration, namespace);
        break;
      default:
        this.emit(`\n/* TODO: ${ts.SyntaxKind[node.kind]} in ${namespace.join('.')} */\n`);
        break;
    }
    this.output = originalOutput;
  }

  private writeExternsType(decl: ts.InterfaceDeclaration|ts.ClassDeclaration, namespace: string[]) {
    let typeName = namespace.concat([decl.name.getText()]).join('.');
    this.emittedNamespaces[typeName] = true;
    if (closureExternsBlacklist.indexOf(typeName) >= 0) return;
    this.emittedNamespaces[typeName] = true;

    let paramNames = '';
    if (decl.kind === ts.SyntaxKind.ClassDeclaration) {
      let ctors =
          (<ts.ClassDeclaration>decl).members.filter((m) => m.kind === ts.SyntaxKind.Constructor);
      if (ctors.length) {
        if (ctors.length > 1) {
          this.error(ctors[1], 'multiple constructor signatures in declarations');
        }
        let ctor = <ts.ConstructorDeclaration>ctors[0];
        this.emitFunctionType(ctor, [{tagName: 'constructor'}, {tagName: 'struct'}]);
        paramNames = ctor.parameters.map((p) => p.name.getText()).join(', ');
      } else {
        this.emit('/** @constructor @struct */\n');
      }
    } else {
      this.emit('/** @record @struct */\n');
    }

    this.writeExternsFunction(decl.name.getText(), paramNames, namespace);

    for (let member of decl.members) {
      switch (member.kind) {
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.PropertyDeclaration:
          let prop = <ts.PropertySignature>member;
          this.emitJSDocType(prop);
          this.emit(`\n${typeName}.prototype.${prop.name.getText()};\n`);
          break;
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.MethodDeclaration:
          let m = <ts.MethodDeclaration>member;
          this.emitFunctionType(m);
          this.emit(
              `${typeName}.prototype.${m.name.getText()} = ` +
              `function(${m.parameters.map((p) => p.name.getText()).join(', ')}) {};\n`);
          break;
        case ts.SyntaxKind.Constructor:
          break;  // Handled above.
        default:
          // Members can include things like index signatures, for e.g.
          //   interface Foo { [key: string]: number; }
          // For now, just skip it unless all the members are regular old
          // properties.
          let name = namespace;
          if (member.name) {
            name = name.concat([member.name.getText()]);
          }
          this.emit(`\n/* TODO: ${ts.SyntaxKind[member.kind]} in ${name.join('.')} */\n`);
      }
    }
  }

  private writeExternsVariable(decl: ts.VariableDeclaration, namespace: string[]) {
    if (decl.name.kind === ts.SyntaxKind.Identifier) {
      let identifier = <ts.Identifier>decl.name;
      let qualifiedName = namespace.concat([getIdentifierText(identifier)]).join('.');
      if (closureExternsBlacklist.indexOf(qualifiedName) >= 0) return;
      this.emitJSDocType(decl);
      if (namespace.length > 0) {
        this.emit(`\n${qualifiedName};\n`);
      } else {
        this.emit(`\nvar ${qualifiedName};\n`);
      }
    } else {
      this.errorUnimplementedKind(decl.name, 'externs for variable');
    }
  }

  private writeExternsFunction(name: string, params: string, namespace: string[]) {
    if (namespace.length > 0) {
      name = namespace.concat([name]).join('.');
      this.emit(`${name} = function(${params}) {};\n`);
    } else {
      this.emit(`function ${name}(${params}) {}\n`);
    }
  }

  private writeExternsEnum(decl: ts.EnumDeclaration, namespace: string[]) {
    namespace = namespace.concat([getIdentifierText(decl.name)]);
    this.emit('\n/** @const */\n');
    this.emit(`${namespace.join('.')} = {};\n`);
    for (let member of decl.members) {
      let memberName = member.name.getText();
      let name = namespace.concat([memberName]).join('.');
      this.emit('/** @const {number} */\n');
      this.emit(`${name};\n`);
    }
  }

  /** Emits a type annotation in JSDoc, or {?} if the type is unavailable. */
  private emitJSDocType(node: ts.Node, additionalDocTag?: string) {
    this.emit(' /**');
    if (additionalDocTag) {
      this.emit(' ' + additionalDocTag);
    }
    this.emit(` @type {${this.typeToClosure(node)}} */`);
  }

  /**
   * Convert a TypeScript ts.Type into the equivalent Closure type.
   *
   * @param context The ts.Node containing the type reference; used for resolving symbols
   *     in context.
   * @param type The type to translate; if not provided, the Node's type will be used.
   * @param destructuring If true, insert a Closure "!" (not-null annotation) on all
   *     object/array types.  This is a workaround specifically for destructuring
   *     bind patterns.
   */
  private typeToClosure(context: ts.Node, type?: ts.Type, destructuring?: boolean): string {
    if (this.options.untyped) {
      return '?';
    }

    let typeChecker = this.program.getTypeChecker();
    if (!type) {
      type = typeChecker.getTypeAtLocation(context);
    }
    let translator = new TypeTranslator(typeChecker, context);
    translator.warn = msg => this.debugWarn(context, msg);
    return translator.translate(type, destructuring);
  }

  private visitTypeAlias(node: ts.TypeAliasDeclaration) {
    if (this.options.untyped) return;
    // Write a Closure typedef, which involves an unused "var" declaration.
    this.emit(`/** @typedef {${this.typeToClosure(node)}} */\n`);
    this.emit(`var ${node.name.getText()}: void;\n`);
  }

  /** Processes an EnumDeclaration or returns false for ordinary processing. */
  private maybeProcessEnum(node: ts.EnumDeclaration): boolean {
    if (node.flags & ts.NodeFlags.Const) {
      // const enums disappear after TS compilation and consequently need no
      // help from tsickle.
      return false;
    }

    // Gather the members of enum, saving the constant value or
    // initializer expression in the case of a non-constant value.
    let members: {[name: string]: number | ts.Node} = {};
    let i = 0;
    for (let member of node.members) {
      let memberName = member.name.getText();
      if (member.initializer) {
        let enumConstValue = this.program.getTypeChecker().getConstantValue(member);
        if (enumConstValue !== undefined) {
          members[memberName] = enumConstValue;
          i = enumConstValue + 1;
        } else {
          // Non-constant enum value.  Save the initializer expression for
          // emitting as-is.
          // Note: if the member's initializer expression refers to another
          // value within the enum (e.g. something like
          //   enum Foo {
          //     Field1,
          //     Field2 = Field1 + something(),
          //   }
          // Then when we emit the initializer we produce invalid code because
          // on the Closure side it has to be written "Foo.Field1 + something()".
          // Hopefully this doesn't come up often -- if the enum instead has
          // something like
          //     Field2 = Field1 + 3,
          // then it's still a constant expression and we inline the constant
          // value in the above branch of this "if" statement.
          members[memberName] = member.initializer;
        }
      } else {
        members[memberName] = i;
        i++;
      }
    }

    // Emit the enum declaration, which looks like:
    //   type Foo = number;
    //   let Foo: any = {};
    // We use an "any" here rather than a more specific type because
    // we think TypeScript has already checked types for us, and it's
    // a bit difficult to provide a type that matches all the interfaces
    // expected of an enum (in particular, it is keyable both by
    // string and number).
    // We don't emit a specific Closure type for the enum because it's
    // also difficult to make work: for example, we can't make the name
    // both a typedef and an indexable object if we export it.
    this.emit('\n');
    let name = node.name.getText();
    if (node.flags & ts.NodeFlags.Export) {
      this.emit('export ');
    }
    this.emit(`type ${name} = number;\n`);
    if (node.flags & ts.NodeFlags.Export) {
      this.emit('export ');
    }
    this.emit(`let ${name}: any = {};\n`);

    // Emit foo.BAR = 0; lines.
    for (let member of Object.keys(members)) {
      if (!this.options.untyped) this.emit(`/** @type {number} */\n`);
      this.emit(`${name}.${member} = `);
      let value = members[member];
      if (typeof value === 'number') {
        this.emit(value.toString());
      } else {
        this.visit(value);
      }
      this.emit(';\n');
    }

    // Emit foo[foo.BAR] = 'BAR'; lines.
    for (let member of Object.keys(members)) {
      this.emit(`${name}[${name}.${member}] = "${member}";\n`);
    }

    return true;
  }

  /**
   * debug logs a debug warning.  These should only be used for cases
   * where tsickle is making a questionable judgement about what to do.
   * By default, tsickle does not report any warnings to the caller,
   * and warnings are hidden behind a debug flag, as warnings are only
   * for tsickle to debug itself.
   */
  private debugWarn(node: ts.Node, messageText: string) {
    if (!this.options.logWarning) return;
    // Use a ts.Diagnosic so that the warning includes context and file offets.
    let diagnostic: ts.Diagnostic = {
      file: this.file,
      start: node.getStart(),
      length: node.getEnd() - node.getStart(), messageText,
      category: ts.DiagnosticCategory.Warning,
      code: undefined,
    };
    this.options.logWarning(diagnostic);
  }
}

export function annotate(program: ts.Program, file: ts.SourceFile, options: Options = {}): Output {
  return new Annotator(program, file, options).annotate();
}

/**
 * PostProcessor postprocesses TypeScript compilation output JS, to rewrite commonjs require()s into
 * goog.require().
 */
class PostProcessor extends Rewriter {
  /**
   * namespaceImports collects the variables for imported goog.modules.
   * If the original TS input is:
   *   import foo from 'goog:bar';
   * then TS produces:
   *   var foo = require('goog:bar');
   * and this class rewrites it to:
   *   var foo = require('goog.bar');
   * After this step, namespaceImports['foo'] is true.
   * (This is used to rewrite 'foo.default' into just 'foo'.)
   */
  namespaceImports: {[varName: string]: boolean} = {};

  /**
   * moduleVariables maps from module names to the variables they're assigned to.
   * Continuing the above example, moduleVariables['goog.bar'] = 'foo'.
   */
  moduleVariables: {[moduleName: string]: string} = {};

  /** strippedStrict is true once we've stripped a "use strict"; from the input. */
  strippedStrict: boolean = false;

  /** unusedIndex is used to generate fresh symbols for unnamed imports. */
  unusedIndex: number = 0;

  constructor(
      file: ts.SourceFile,
      private pathToModuleName: (context: string, fileName: string) => string) {
    super(file);
  }

  process(): {output: string, referencedModules: string[]} {
    // TODO(evanm): only emit the goog.module *after* the first comment,
    // so that @suppress statements work.
    const moduleName = this.pathToModuleName('', this.file.fileName);
    // NB: No linebreak after module call so sourcemaps are not offset.
    this.emit(`goog.module('${moduleName}');`);

    let pos = 0;
    for (let stmt of this.file.statements) {
      this.writeRange(pos, stmt.getFullStart());
      this.visitTopLevel(stmt);
      pos = stmt.getEnd();
    }
    this.writeRange(pos, this.file.getEnd());

    let referencedModules = Object.keys(this.moduleVariables);
    // Note: don't sort referencedModules, as the keys are in the same order
    // they occur in the source file.
    let {output} = this.getOutput();
    return {output, referencedModules};
  }

  /**
   * visitTopLevel processes a top-level ts.Node and emits its contents.
   *
   * It's separate from the normal Rewriter recursive traversal
   * because some top-level statements are handled specially.
   */
  visitTopLevel(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.ExpressionStatement:
        // Check for "use strict" and skip it if necessary.
        if (!this.strippedStrict && this.isUseStrict(node)) {
          this.writeRange(node.getFullStart(), node.getStart());
          this.strippedStrict = true;
          return;
        }
        // Check for:
        // - "require('foo');" (a require for its side effects)
        // - "__export(require(...));" (an "export * from ...")
        if (this.emitRewrittenRequires(node)) {
          return;
        }
        // Otherwise fall through to default processing.
        break;
      case ts.SyntaxKind.VariableStatement:
        // Check for a "var x = require('foo');".
        if (this.emitRewrittenRequires(node)) return;
        break;
      default:
        break;
    }
    this.visit(node);
  }

  /** isUseStrict returns true if node is a "use strict"; statement. */
  isUseStrict(node: ts.Node): boolean {
    if (node.kind !== ts.SyntaxKind.ExpressionStatement) return false;
    let exprStmt = node as ts.ExpressionStatement;
    let expr = exprStmt.expression;
    if (expr.kind !== ts.SyntaxKind.StringLiteral) return false;
    let literal = expr as ts.StringLiteral;
    return literal.text === 'use strict';
  }

  /**
   * emitRewrittenRequires rewrites require()s into goog.require() equivalents.
   *
   * @return True if the node was rewritten, false if needs ordinary processing.
   */
  emitRewrittenRequires(node: ts.Node): boolean {
    // We're looking for requires, of one of the forms:
    // - "var importName = require(...);".
    // - "require(...);".
    // Find the CallExpression contained in either of these.
    let varName: string;          // E.g. importName in the above example.
    let call: ts.CallExpression;  // The require(...) expression.
    if (node.kind === ts.SyntaxKind.VariableStatement) {
      // It's possibly of the form "var x = require(...);".
      let varStmt = node as ts.VariableStatement;

      // Verify it's a single decl (and not "var x = ..., y = ...;").
      if (varStmt.declarationList.declarations.length !== 1) return false;
      let decl = varStmt.declarationList.declarations[0];

      // Grab the variable name (avoiding things like destructuring binds).
      if (decl.name.kind !== ts.SyntaxKind.Identifier) return false;
      varName = getIdentifierText(decl.name as ts.Identifier);
      if (!decl.initializer || decl.initializer.kind !== ts.SyntaxKind.CallExpression) return false;
      call = decl.initializer as ts.CallExpression;
    } else if (node.kind === ts.SyntaxKind.ExpressionStatement) {
      // It's possibly of the form:
      // - require(...);
      // - __export(require(...));
      // Both are CallExpressions.
      let exprStmt = node as ts.ExpressionStatement;
      let expr = exprStmt.expression;
      if (expr.kind !== ts.SyntaxKind.CallExpression) return false;
      call = expr as ts.CallExpression;

      let require = this.isExportRequire(call);
      if (require) {
        let modName = this.pathToModuleName(this.file.fileName, require);
        this.writeRange(node.getFullStart(), node.getStart());
        this.emit(`__export(goog.require('${modName}'));`);
        // Mark that this module was imported; it doesn't have an associated
        // variable so just call the variable "*".
        this.moduleVariables[modName] = '*';
        return true;
      }
    } else {
      // It's some other type of statement.
      return false;
    }

    let require = this.isRequire(call);
    if (!require) return false;

    // Even if it's a bare require(); statement, introduce a variable for it.
    // This avoids a Closure error.
    if (!varName) {
      varName = `unused_${this.unusedIndex++}_`;
    }

    let modName: string;
    if (require.match(/^goog:/)) {
      // This is a namespace import, of the form "goog:foo.bar".
      // Fix it to just "foo.bar", and save the variable name.
      modName = require.substr(5);
      this.namespaceImports[varName] = true;
    } else {
      modName = this.pathToModuleName(this.file.fileName, require);
    }

    this.writeRange(node.getFullStart(), node.getStart());
    if (this.moduleVariables.hasOwnProperty(modName)) {
      this.emit(`var ${varName} = ${this.moduleVariables[modName]};`);
    } else {
      this.emit(`var ${varName} = goog.require('${modName}');`);
      this.moduleVariables[modName] = varName;
    }
    return true;
  }

  /**
   * Returns the string argument if call is of the form
   *   require('foo')
   */
  isRequire(call: ts.CallExpression): string {
    // Verify that the call is a call to require(...).
    if (call.expression.kind !== ts.SyntaxKind.Identifier) return null;
    let ident = call.expression as ts.Identifier;
    if (getIdentifierText(ident) !== 'require') return null;

    // Verify the call takes a single string argument and grab it.
    if (call.arguments.length !== 1) return null;
    let arg = call.arguments[0];
    if (arg.kind !== ts.SyntaxKind.StringLiteral) return null;
    return (arg as ts.StringLiteral).text;
  }

  /**
   * Returns the inner string if call is of the form
   *   __export(require('foo'))
   */
  isExportRequire(call: ts.CallExpression): string {
    if (call.expression.kind !== ts.SyntaxKind.Identifier) return null;
    let ident = call.expression as ts.Identifier;
    if (ident.getText() !== '__export') return null;

    // Verify the call takes a single string argument and grab it.
    if (call.arguments.length !== 1) return null;
    let arg = call.arguments[0];
    if (arg.kind !== ts.SyntaxKind.CallExpression) return null;
    return this.isRequire(arg as ts.CallExpression);
  }

  /**
   * maybeProcess is called during the recursive traversal of the program's AST.
   *
   * @return True if the node was processed/emitted, false if it should be emitted as is.
   */
  protected maybeProcess(node: ts.Node): boolean {
    switch (node.kind) {
      case ts.SyntaxKind.PropertyAccessExpression:
        let propAccess = node as ts.PropertyAccessExpression;
        // We're looking for an expression of the form:
        //   module_name_var.default
        if (getIdentifierText(propAccess.name) !== 'default') break;
        if (propAccess.expression.kind !== ts.SyntaxKind.Identifier) break;
        let lhs = getIdentifierText(propAccess.expression as ts.Identifier);
        if (!this.namespaceImports.hasOwnProperty(lhs)) break;
        // Emit the same expression, with spaces to replace the ".default" part
        // so that source maps still line up.
        this.writeRange(node.getFullStart(), node.getStart());
        this.emit(`${lhs}        `);
        return true;
      default:
        break;
    }
    return false;
  }
}

/**
 * Converts TypeScript's JS+CommonJS output to Closure goog.module etc.
 * For use as a postprocessing step *after* TypeScript emits JavaScript.
 *
 * @param fileName The source file name, without an extension.
 * @param pathToModuleName A function that maps a filesystem .ts path to a
 *     Closure module name, as found in a goog.require('...') statement.
 *     The context parameter is the referencing file, used for resolving
 *     imports with relative paths like "import * as foo from '../foo';".
 */
export function convertCommonJsToGoogModule(
    fileName: string, content: string, pathToModuleName: (context: string, fileName: string) =>
                                           string): {output: string, referencedModules: string[]} {
  let file = ts.createSourceFile(fileName, content, ts.ScriptTarget.ES5, true);
  return new PostProcessor(file, pathToModuleName).process();
}
