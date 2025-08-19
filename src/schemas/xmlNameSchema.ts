import { z } from "zod";

const xmlNameRegex = new RegExp(
  /^([a-zA-Z_]|:)([\w.-]|:)*$/,
);

export const xmlNameSchema = z.string().refine(
  (name) => xmlNameRegex.test(name) && !name.startsWith("xml"),
  {
    message: "String must be a valid XML name.",
  }
);