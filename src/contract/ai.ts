// The assistant pane's API (server/src/ai.rs): the pane asks for the session of the PDF it
// shows and loads the two addresses the answer gives, in this order, in its frame. The first
// pairs the frame with the private OpenCode server (one use); the second is the PDF's chat.
import { z } from "zod";
import { NonEmptySchema } from "./text";

export const AiSessionRequestSchema = z.strictObject({ key: NonEmptySchema });

export const AiSessionSchema = z.strictObject({
  pairUrl: z.url({ protocol: /^http$/ }),
  sessionUrl: z.url({ protocol: /^http$/ }),
});
