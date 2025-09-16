import { z } from "zod";

export const echo = {
  name: "echo",
  description: "Echoes the input string",
  input: { message: z.string() },
  execute: async ({ message }: { message: string }, context: any) => {
    return {
      content: [
        { type: "text", text: `You said: ${message}` }
      ],
    };
  }
};