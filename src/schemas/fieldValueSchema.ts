import { z } from "zod";
import { linkSchema } from "./linkSchema.js";

const listDefinitionSchema = z.discriminatedUnion("$type", [
  z.object({
    "$type": z.literal("ListDefinition"),
    Type: z.enum(["Select", "Radio", "Checkbox", "Tree"]),
    Height: z.number().int().optional().describe("The height of the list control in the UI."),
    Entries: z.array(linkSchema).optional()
  }),
  z.object({
    "$type": z.literal("NumberListDefinition"),
    Type: z.enum(["Select", "Radio", "Checkbox"]),
    Height: z.number().int().optional().describe("The height of the list control in the UI."),
    Entries: z.array(z.number()).optional()
  }),
  z.object({
    "$type": z.literal("DateListDefinition"),
    Type: z.enum(["Select", "Radio", "Checkbox"]),
    Height: z.number().int().optional().describe("The height of the list control in the UI."),
    Entries: z.array(z.string().datetime()).optional()
  }),
  z.object({
    "$type": z.literal("SingleLineTextListDefinition"),
    Type: z.enum(["Select", "Radio", "Checkbox"]),
    Height: z.number().int().optional().describe("The height of the list control in the UI."),
    Entries: z.array(z.string()).optional()
  })
]);

// Base schema with common properties for all field types
const baseFieldSchema = z.object({
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
});

// Schema for a simple text field
const singleLineTextFieldSchema = z.object({
    "$type": z.literal("SingleLineTextFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a multi-line text area
const multiLineTextFieldSchema = z.object({
    "$type": z.literal("MultiLineTextFieldDefinition")
}).merge(baseFieldSchema).extend({
    Height: z.number().int().optional().describe("The height of the text area in the UI.")
});

// Schema for a rich-text (HTML) editor
const xhtmlFieldSchema = z.object({
    "$type": z.literal("XhtmlFieldDefinition")
}).merge(baseFieldSchema).extend({
    Height: z.number().int().optional().describe("The height of the rich text editor in the UI.")
});

// Schema for a Keyword link field
const keywordFieldSchema = z.object({
    "$type": z.literal("KeywordFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional(),
    Category: linkSchema.describe("A Link to the Category from which Keywords can be selected."),
    AllowAutoClassification: z.boolean().optional().describe("Whether to allow automatic classification for this Keyword field.")
});

// Schema for a numeric field
const numberFieldSchema = z.object({
    "$type": z.literal("NumberFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a date/time field
const dateFieldSchema = z.object({
    "$type": z.literal("DateFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a URL field
const externalLinkFieldSchema = z.object({
    "$type": z.literal("ExternalLinkFieldDefinition")
}).merge(baseFieldSchema);

// Schema for a Component link field
const componentLinkFieldSchema = z.object({
    "$type": z.literal("ComponentLinkFieldDefinition")
}).merge(baseFieldSchema).extend({
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of Components can be linked.")
});

// Schema for a Multimedia link field
const multimediaLinkFieldSchema = z.object({
    "$type": z.literal("MultimediaLinkFieldDefinition")
}).merge(baseFieldSchema).extend({
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of multimedia can be linked.")
});

// Schema for an embedded Schema field
const embeddedSchemaFieldSchema = z.object({
    "$type": z.literal("EmbeddedSchemaFieldDefinition")
}).merge(baseFieldSchema).extend({
    EmbeddedSchema: linkSchema.describe("A Link object to the Schema to be embedded.")
});

// The master schema for any valid field definition, using a discriminated union
export const fieldDefinitionSchema = z.discriminatedUnion("$type", [
    singleLineTextFieldSchema,
    multiLineTextFieldSchema,
    xhtmlFieldSchema,
    keywordFieldSchema,
    numberFieldSchema,
    dateFieldSchema,
    externalLinkFieldSchema,
    componentLinkFieldSchema,
    multimediaLinkFieldSchema,
    embeddedSchemaFieldSchema
]);

const primitiveFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  linkSchema,
]);

// --- New "Guidance" Schema for Container Elements ---
// This explicitly says: "Try to match a primitive first, otherwise, allow anything."
const flexibleElementSchema = z.union([primitiveFieldValueSchema, z.unknown()]);

export const fieldValueSchema = z.union([
  // 1. A simple primitive is still allowed at the top level.
  primitiveFieldValueSchema,

  // 2. An array is allowed, containing our new flexible element type.
  z.array(flexibleElementSchema),

  // 3. A record is allowed, containing our new flexible element type.
  z.record(flexibleElementSchema),
]);
