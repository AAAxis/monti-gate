// The invariant the MCP step catalogue leans on: every `connector` field in
// step-schema.json declares which category of connector it takes.
//
// Written after an agent authoring a notify step over MCP guessed five
// connector ids in a row and gave up. Two things had to be true for that to
// happen, and this file pins the half that lives in the schema: the compaction
// in electron/mcp/tools.cjs now renders a connector field as "<category>
// connector id from scout_list_connectors", and a field with no category would
// silently degrade that back to "any" -- the useless answer it used to give.
//
// The other half was that no tool listed connectors at all. That one is a
// route, not an invariant, and is covered by scripts/verify-api-routes.mjs.
import {describe, expect, it} from 'vitest';
import stepSchema from '../../electron/automation/step-schema.json';

type SchemaField = {key: string; kind: string; category?: string};
type SchemaStep = {fields?: SchemaField[]};

const steps = stepSchema as unknown as Record<string, SchemaStep>;

function connectorFields(): Array<{type: string; field: SchemaField}> {
  return Object.entries(steps).flatMap(([type, spec]) =>
    (spec.fields || [])
        .filter((field) => field.kind === 'connector')
        .map((field) => ({type, field})));
}

describe('connector fields in step-schema.json', () => {
  it('exist at all -- three steps take one today', () => {
    expect(connectorFields().map((entry) => `${entry.type}.${entry.field.key}`))
        .toEqual(['aiPrompt.provider', 'aiCheck.provider', 'notify.connector']);
  });

  // A notify step must not be able to name a model, and an aiPrompt must not
  // be able to name a bot. The category is what StepFields filters the
  // dropdown on and what connectors.cjs resolve() refuses on -- a field
  // without one would offer the whole list to both.
  it('each declares the category of connector it takes', () => {
    for (const {type, field} of connectorFields()) {
      expect(
          field.category,
          `${type}.${field.key} has no category`,
      ).toMatch(/^(ai|message)$/);
    }
  });
});
