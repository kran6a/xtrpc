#!/usr/bin/env node

// src/index.ts
import {Project} from "ts-morph";
import {join} from "path";

// src/ast.ts
function* iterateNodes(sourceFiles) {
  for (const sourceFile of sourceFiles) {
    for (const node of sourceFile.getDescendants()) {
      yield [node, sourceFile];
    }
  }
}
var findNodeOrThrow = (sourceFiles, predicate) => {
  for (const [node, sourceFile] of iterateNodes(sourceFiles)) {
    if (predicate(node)) {
      return [node, sourceFile];
    }
  }
  throw new Error("Could not find file.");
};
var getFirstSiblingByKindOrThrow = (node, kind) => {
  for (const sibling of node.getNextSiblings()) {
    if (sibling.getKind() === kind) {
      return sibling;
    }
  }
  throw new Error(`A sibling of kind ${kind.toString()} was expected.`);
};

// src/config.ts
import fs from "fs/promises";
import {z} from "zod";
var Config = z.object({
  srcProject: z.string().optional().default("."),
  dstProject: z.string().optional().default("."),
  outDir: z.string().optional().default("types"),
  outName: z.string().optional().default("api.d.ts"),
  overwrite: z.boolean().optional().default(false),
  explicitOutputs: z.boolean().optional().default(false),
  include: z.record(z.string().array()).default({}),
  parserOptions: z.object({ appRouterAlias: z.string().optional().default("AppRouter") }).optional().default({ appRouterAlias: "AppRouter" })
});
var readFile = async (path) => {
  try {
    return await fs.readFile(path, { encoding: "utf8" });
  } catch {
    return;
  }
};
var toJson = (s, ctx) => {
  try {
    return JSON.parse(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON" });
    return z.NEVER;
  }
};
var readConfig = async (path) => z.string().optional().default("{}").transform(toJson).pipe(Config).parse(await readFile(path));

// src/guard.ts
import {ts} from "ts-morph";
var isContext = (node) => node.getKind() === ts.SyntaxKind.PropertyAccessExpression && node.getText().endsWith(".context");
var isMiddleware = (node) => node.getKind() === ts.SyntaxKind.PropertyAccessExpression && node.getText().endsWith(".use");
var isProcedure = (node) => node.getKind() === ts.SyntaxKind.PropertyAccessExpression && (node.getText().endsWith(".query") || node.getText().endsWith(".mutation") || node.getText().endsWith(".subscription"));
var isRouter = (node) => node.getKind() === ts.SyntaxKind.Identifier && node.getParent()?.getKind() === ts.SyntaxKind.CallExpression && node.getText() === "router";
var isAppRouterAlias = (text) => (node) => node.getKind() === ts.SyntaxKind.Identifier && node.getParent()?.getKind() === ts.SyntaxKind.TypeAliasDeclaration && node.getText() === text;

// src/stripper.ts
import {readFileSync, writeFileSync} from "fs";
function stripper_default(path) {
  const file = readFileSync(path).toString("utf8").replaceAll(/\s*transformer:.*;$/g, "").replaceAll(/\s*_input_out: .*;/g, "").replaceAll(/\s*_input_out: {(?:[^_])*;/g, "").replaceAll(/\s*_output_in: .*;/g, "").replaceAll(/\s*_output_in: {(?:[^_])*;/g, "").replaceAll(/\s*middleware: <([\s\S])*, TNewParams>;/g, "").replaceAll(/\s*_ctx_out: any;/g, "").replaceAll(/\s*_ctx_out: object;/g, "").replaceAll(/\s*_meta: object;/g, "").replaceAll(/\s*_config: import\("@trpc\/server"\)\.RootConfig<{[^}]*}>;/g, "");
  console.log(file);
  writeFileSync(path, file);
}

// src/transformer.ts
import {ts as ts2} from "ts-morph";
var getAllTransformers = (files, transformations) => [...iterateNodes(files)].flatMap(([node]) => transformations.flatMap(([predicate, transform]) => predicate(node) ? transform(node) : []));
var redefine = (text) => (node) => {
  const sibling = getFirstSiblingByKindOrThrow(node, ts2.SyntaxKind.SyntaxList);
  return [() => sibling.replaceWithText(text)];
};
var pruneRouter = (include, explicitOutputs) => (node) => {
  const includeAll = Object.keys(include).length === 0;
  const expr = node.getParentOrThrow().getFirstDescendantByKindOrThrow(ts2.SyntaxKind.ObjectLiteralExpression);
  const ret = expr.getChildrenOfKind(ts2.SyntaxKind.PropertyAssignment).flatMap((route) => {
    const [k, _, v] = route.getChildren();
    if (!k || !v) {
      throw new Error("Unexpected router");
    }
    if (v.getKind() === ts2.SyntaxKind.CallExpression) {
      const subrouter = route.getFirstAncestorByKindOrThrow(ts2.SyntaxKind.VariableDeclaration)?.getFirstChildByKindOrThrow(ts2.SyntaxKind.Identifier);
      const match = Object.entries(include).find(([r, procs]) => r === subrouter.getText() && procs.includes(k.getText()));
      if (!match && !includeAll) {
        return [() => route.remove()];
      }
      return explicitOutputs ? route.getDescendants().flatMap((n) => isProcedure(n) ? [() => redefine("() => undefined as any")(n)] : []) : [];
    }
    if (v.getKind() === ts2.SyntaxKind.Identifier) {
      const match = Object.keys(include).find((r) => r === v.getText());
      return match || includeAll ? [] : [() => route.remove()];
    }
    return [];
  });
  console.log(ret);
  return ret;
};

// src/index.ts
var main = async () => {
  const cfg = await readConfig("xtrpc.config.json");
  const srcProj = new Project({
    tsConfigFilePath: `${cfg.srcProject}/tsconfig.json`,
    compilerOptions: { outDir: "dist", declaration: true, noEmit: false }
  });
  const srcFiles = srcProj.getSourceFiles();
  const transformers = getAllTransformers(srcFiles, [
    [isContext, redefine("any")],
    [isMiddleware, redefine("t.middleware(({ ctx, next }) => next({ ctx }))")],
    [isRouter, pruneRouter(cfg.include, cfg.explicitOutputs)]
  ]);
  for (const transform of transformers) {
    transform();
  }
  const [appRouter, rootFile] = findNodeOrThrow(srcFiles, isAppRouterAlias(cfg.parserOptions.appRouterAlias));
  appRouter.replaceWithText("API");
  const [dstFile] = srcProj.getSourceFileOrThrow(rootFile.getBaseName()).getEmitOutput({ emitOnlyDtsFiles: true }).getOutputFiles();
  const dstProj = new Project({
    tsConfigFilePath: `${cfg.dstProject}/tsconfig.json`
  });
  if (!dstFile) {
    throw new Error("Could not emit output.");
  }
  const outPath = join(cfg.dstProject, cfg.outDir, cfg.outName);
  dstProj.createSourceFile(outPath, dstFile.getText(), {
    overwrite: cfg.overwrite
  });
  await dstProj.save();
  stripper_default(outPath);
  return `Generated ${outPath}`;
};
main().then(console.log.bind(console)).catch(console.error.bind(console));
