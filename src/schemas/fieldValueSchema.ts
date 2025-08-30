import { z } from "zod";
import { linkSchema } from "./linkSchema.js";

const formattingFeaturesSchema = z.object({
  "$type": z.literal("FormattingFeatures"),
  AccessibilityLevel: z.number().int().optional().describe("Gets or sets the Web Content Accessibility Guidelines (WCAG) setting that you choose, shows or hides buttons for the various WCAG levels."),
  DisallowedActions: z.array(z.string()).optional().describe("Gets or sets the formatting actions that a user can not perform on text within the format area."),
  DisallowedStyles: z.array(z.string()).optional().describe("Gets or sets the styles that a user can not apply to text within a format area."),
  DocType: z.enum(["Strict", "Transitional"]).optional().describe("Gets or sets the rules that are applied to this format area when Components based on this Schema are validated. You have the option of selecting \"Strict\" or \"Transitional\" document types.")
});

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

const singleLineTextFieldSchema = z.object({
    "$type": z.literal("SingleLineTextFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    List: listDefinitionSchema.optional()
});

const multiLineTextFieldSchema = z.object({
    "$type": z.literal("MultiLineTextFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    Height: z.number().int().default(2).describe("The height of the text area in the UI.")
});

const xhtmlFieldSchema = z.object({
    "$type": z.literal("XhtmlFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    Height: z.number().int().default(5).describe("The height of the rich text editor in the UI."),
    FormattingFeatures: formattingFeaturesSchema.optional().describe("Specifies the formatting options for the XHTML field.")
});

const keywordFieldSchema = z.object({
    "$type": z.literal("KeywordFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    List: listDefinitionSchema,
    Category: linkSchema.describe("A Link to the Category from which Keywords can be selected."),
    AllowAutoClassification: z.boolean().optional().describe("Whether to allow automatic classification for this Keyword field.")
});

const numberFieldSchema = z.object({
    "$type": z.literal("NumberFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    List: listDefinitionSchema.optional()
});

const dateFieldSchema = z.object({
    "$type": z.literal("DateFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    List: listDefinitionSchema.optional()
});

const externalLinkFieldSchema = z.object({
    "$type": z.literal("ExternalLinkFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing.")
});

const componentLinkFieldSchema = z.object({
    "$type": z.literal("ComponentLinkFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of Components can be linked.")
});

const multimediaLinkFieldSchema = z.object({
    "$type": z.literal("MultimediaLinkFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of multimedia can be linked.")
});

const embeddedSchemaFieldSchema = z.object({
    "$type": z.literal("EmbeddedSchemaFieldDefinition"),
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
    EmbeddedSchema: linkSchema.describe("A Link object to the Schema to be embedded."),
    EmbeddedFields: z.object({}).optional().describe("This property is handled automatically by the tool and does not need to be provided.")
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

const deepFieldSchema = z.union([
  primitiveFieldValueSchema,
  z.array(primitiveFieldValueSchema),
  z.record(primitiveFieldValueSchema),
]);

export const fieldValueSchema = z.union([
  primitiveFieldValueSchema,
  z.array(z.union([deepFieldSchema, z.unknown()])),
  z.record(z.union([deepFieldSchema, z.unknown()])).describe("For an embedded schema field, this represents the object containing the embedded fields. The tool will automatically reorder the fields to match the schema definition."),
]);
