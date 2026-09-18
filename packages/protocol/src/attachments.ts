import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PROMPT = 6;

/** File bytes ride the already-authenticated prompt rather than a new fetch endpoint. */
export const PromptAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  data: z.string().min(1),
});
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export const PromptAttachmentsSchema = z
  .array(PromptAttachmentSchema)
  .max(MAX_ATTACHMENTS_PER_PROMPT)
  .refine(
    (attachments) =>
      attachments.reduce(
        (bytes, attachment) => bytes + base64Bytes(attachment.data),
        0,
      ) <= MAX_ATTACHMENT_BYTES,
    "Attachments exceed the 10 MiB prompt limit",
  );
