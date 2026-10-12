import ts from 'typescript';
import type { EndIn } from './schema.js';

export const LOOP_FILE = 'packages/core/src/loop.ts';
export const SERVE_FILE = 'packages/engine/src/serve.ts';

interface NextStep {
  readonly kind: string;
  readonly reason?: string | undefined;
}

/** The engine's tables for how a turn ends, read from their declarations so a page can be checked against them. */
export interface EndTables {
  /** `AFTER_STOP`: a model stop reason, and the loop step it leads to. */
  readonly afterStop: ReadonlyMap<string, NextStep>;
  /** `TURN_ENDS`: a turn end (a DoneReason or `cancelled`), and the task end and ACP stop it goes out as. */
  readonly turnEnds: ReadonlyMap<string, { readonly task: string; readonly stop: string }>;
  /** The `LoopStep` kinds other than `done`: a step that keeps the turn going. */
  readonly goingOn: ReadonlySet<string>;
}

export type EndTablesResult = { readonly ok: true; readonly tables: EndTables } | { readonly ok: false; readonly file: string; readonly reason: string };

/** A tool_use stop with tool uses runs them before AFTER_STOP is consulted, so a model step that asks for tools goes on. */
const ASKS_FOR_TOOLS = 'tool_use';

class Unreadable extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
  }
}

const sourceOf = (file: string, text: string): ts.SourceFile => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function topLevel(source: ts.SourceFile, name: string): ts.VariableDeclaration | ts.TypeAliasDeclaration | undefined {
  const declarations = source.statements.flatMap<ts.VariableDeclaration | ts.TypeAliasDeclaration>((statement) =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations : ts.isTypeAliasDeclaration(statement) ? [statement] : [],
  );
  return declarations.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
}

const constOf = (source: ts.SourceFile, name: string): ts.Expression | undefined => {
  const declaration = topLevel(source, name);
  return declaration !== undefined && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
};

const keyOf = (name: ts.PropertyName): string | undefined => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined);

function objectOf(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  const init = constOf(source, name);
  if (init === undefined) throw new Unreadable(source.fileName, `no top-level const named ${name}: docs:check reads how a turn ends from it`);
  if (!ts.isObjectLiteralExpression(init)) throw new Unreadable(source.fileName, `${name} is not an object literal, so docs:check cannot read it`);
  return init;
}

function entriesOf(object: ts.ObjectLiteralExpression, table: string, file: string): [string, ts.Expression][] {
  return object.properties.map((property) => {
    const key = property.name === undefined ? undefined : keyOf(property.name);
    if (!ts.isPropertyAssignment(property) || key === undefined) throw new Unreadable(file, `${table} has an entry docs:check cannot read: ${property.getText()}`);
    return [key, property.initializer];
  });
}

function stringsOf(object: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  return new Map(object.properties.flatMap((property) => (ts.isPropertyAssignment(property) && keyOf(property.name) !== undefined ? [[keyOf(property.name)!, property.initializer]] : [])));
}

const literal = (node: ts.Expression | undefined): string | undefined => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);

/** A loop step written as `{ kind: 'x' }`, a const naming one, or a call to an arrow that returns `({ kind: 'x', reason })`. */
function stepOf(source: ts.SourceFile, value: ts.Expression, where: string): NextStep {
  const unreadable = (): never => {
    throw new Unreadable(source.fileName, `${where} is ${value.getText()}, which docs:check cannot read as a loop step`);
  };
  if (ts.isObjectLiteralExpression(value)) {
    const fields = stringsOf(value);
    return { kind: literal(fields.get('kind')) ?? unreadable(), reason: literal(fields.get('reason')) };
  }
  if (ts.isIdentifier(value)) {
    const init = constOf(source, value.text);
    return init === undefined ? unreadable() : stepOf(source, init, where);
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.arguments.length === 1) {
    const arrow = constOf(source, value.expression.text);
    if (arrow === undefined || !ts.isArrowFunction(arrow)) return unreadable();
    let body = arrow.body;
    while (ts.isParenthesizedExpression(body)) body = body.expression;
    if (!ts.isObjectLiteralExpression(body)) return unreadable();
    return { kind: literal(stringsOf(body).get('kind')) ?? unreadable(), reason: literal(value.arguments[0]) ?? unreadable() };
  }
  return unreadable();
}

function loopKinds(source: ts.SourceFile): Set<string> {
  const alias = topLevel(source, 'LoopStep');
  if (alias === undefined || !ts.isTypeAliasDeclaration(alias) || !ts.isUnionTypeNode(alias.type)) throw new Unreadable(source.fileName, 'no union type named LoopStep: docs:check reads the loop step kinds from it');
  return new Set(
    alias.type.types.map((member) => {
      const kind = ts.isTypeLiteralNode(member) ? member.members.find((field) => field.name !== undefined && keyOf(field.name) === 'kind') : undefined;
      const type = kind !== undefined && ts.isPropertySignature(kind) ? kind.type : undefined;
      if (type === undefined || !ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Unreadable(source.fileName, `a LoopStep member has no string kind: ${member.getText()}`);
      return type.literal.text;
    }),
  );
}

export function readEndTables(loopText: string, serveText: string): EndTablesResult {
  try {
    const loop = sourceOf(LOOP_FILE, loopText);
    const serve = sourceOf(SERVE_FILE, serveText);
    const kinds = loopKinds(loop);
    if (!kinds.has('done')) throw new Unreadable(LOOP_FILE, 'LoopStep has no done kind');
    const afterStop = new Map(entriesOf(objectOf(loop, 'AFTER_STOP'), 'AFTER_STOP', LOOP_FILE).map(([key, value]) => [key, stepOf(loop, value, `AFTER_STOP.${key}`)] as const));
    if (!afterStop.has(ASKS_FOR_TOOLS)) throw new Unreadable(LOOP_FILE, `AFTER_STOP has no ${ASKS_FOR_TOOLS} entry`);
    const turnEnds = new Map(
      entriesOf(objectOf(serve, 'TURN_ENDS'), 'TURN_ENDS', SERVE_FILE).map(([key, value]) => {
        const fields = ts.isObjectLiteralExpression(value) ? stringsOf(value) : new Map<string, ts.Expression>();
        const task = literal(fields.get('task'));
        const stop = literal(fields.get('stop'));
        if (task === undefined || stop === undefined) throw new Unreadable(SERVE_FILE, `TURN_ENDS.${key} has no string task and stop: ${value.getText()}`);
        return [key, { task, stop }] as const;
      }),
    );
    for (const [stop, next] of afterStop) {
      if (!kinds.has(next.kind)) throw new Unreadable(LOOP_FILE, `AFTER_STOP.${stop} leads to kind ${next.kind}, which LoopStep does not have`);
      if (next.kind === 'done' && !turnEnds.has(next.reason ?? '')) throw new Unreadable(SERVE_FILE, `TURN_ENDS has no entry for ${next.reason}, which AFTER_STOP.${stop} ends with`);
    }
    kinds.delete('done');
    return { ok: true, tables: { afterStop, turnEnds, goingOn: kinds } };
  } catch (error) {
    if (error instanceof Unreadable) return { ok: false, file: error.file, reason: error.message };
    throw error;
  }
}

/** The `turn:` values a reason allows, and the table that says so; undefined when no table names the reason. */
function turnsFor(reason: string, tables: EndTables): { readonly turns: readonly string[]; readonly because: string } | undefined {
  const end = tables.turnEnds.get(reason);
  if (end !== undefined) return { turns: [end.task], because: `TURN_ENDS.${reason} is task ${end.task} (${SERVE_FILE})` };
  const next = tables.afterStop.get(reason);
  if (next !== undefined) {
    if (next.kind !== 'done') return { turns: ['continues'], because: `AFTER_STOP.${reason} is ${next.kind} (${LOOP_FILE})` };
    const task = tables.turnEnds.get(next.reason!)!.task;
    return { turns: [task], because: `AFTER_STOP.${reason} is done(${next.reason}) (${LOOP_FILE}), and TURN_ENDS.${next.reason} is task ${task} (${SERVE_FILE})` };
  }
  if (tables.goingOn.has(reason)) return { turns: ['continues'], because: `${reason} is a LoopStep that keeps the turn going (${LOOP_FILE})` };
  const sent = [...tables.turnEnds].filter(([, value]) => value.stop === reason);
  if (sent.length > 0) {
    const turns = [...new Set(sent.map(([, value]) => value.task))];
    return { turns, because: `ACP stop ${reason} goes out for ${sent.map(([key, value]) => `${key} (task ${value.task})`).join(', ')} in TURN_ENDS (${SERVE_FILE})` };
  }
  return undefined;
}

/**
 * Problems with a step's `end` against the engine's tables: a reason the tables name must sit on the turn they give it,
 * and a step where the turn's own model stops must end the walk the way AFTER_STOP and TURN_ENDS end that stop.
 */
export function endProblems(end: EndIn, modelStops: readonly string[], tables: EndTables): { readonly field: 'reason' | 'emits'; readonly message: string }[] {
  const problems: { field: 'reason' | 'emits'; message: string }[] = [];
  const allowed = end.reason === undefined ? undefined : turnsFor(end.reason, tables);
  if (end.reason === ASKS_FOR_TOOLS && end.turn === 'continues') problems.push({ field: 'reason', message: `turn: continues with reason ${ASKS_FOR_TOOLS}, but a ${ASKS_FOR_TOOLS} stop that goes on runs its tool uses: write reason: run-tools` });
  else if (allowed !== undefined && !allowed.turns.includes(end.turn)) problems.push({ field: 'reason', message: `turn: ${end.turn} with reason ${end.reason}, but ${allowed.because}: write turn: ${allowed.turns.join(' or ')}` });
  for (const stop of modelStops) {
    if (!tables.afterStop.has(stop) || stop === end.reason || (stop === ASKS_FOR_TOOLS && end.turn === 'continues')) continue;
    const expected = turnsFor(stop, tables)!;
    if (!expected.turns.includes(end.turn)) problems.push({ field: 'emits', message: `the model stops with ${stop} here and the walk ends with turn: ${end.turn}, but ${expected.because}` });
  }
  return problems;
}
