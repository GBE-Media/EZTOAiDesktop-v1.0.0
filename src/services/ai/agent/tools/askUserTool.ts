import { z } from 'zod';
import type { AssistantToolDefinition } from '../../tools/types';
import { sanitizeClarificationFields } from '../askUser';

const optionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

const fieldSchema = z.object({
  id: z.string().min(1).describe('Short id, e.g. "fixture_va".'),
  kind: z.enum(['choice', 'text', 'point', 'area']).describe('choice: buttons · text: typed answer · point: user clicks a spot on the drawing · area: user drags a box on the drawing.'),
  prompt: z.string().min(1).describe('The question for this step.'),
  options: z.array(optionSchema).max(6).optional().describe('choice fields: 2–6 clickable answers.'),
  recommended: z.string().optional().describe('Value of the option you recommend (pre-selected).'),
  placeholder: z.string().optional().describe('text fields (or choice fields that also accept a typed answer): hint text.'),
  documentId: z.string().optional(),
  page: z.number().int().positive().optional().describe('point/area fields: which page to pick on.'),
  optional: z.boolean().optional(),
});

/**
 * The model's way to ask the user anything: a question card with clickable choices, typed answers
 * or a spot / area picked on the drawing. The run pauses and resumes with the answers.
 */
export function createAskUserTool(): AssistantToolDefinition {
  return {
    id: 'ask_user',
    title: 'Ask the user',
    description:
      'Ask the user a question or clarification with a card (never ask in plain text). '
      + 'Put every input you need into one card as fields: choice (2–6 options, mark the one you recommend), text, point (they click it on the drawing) or area (they drag a box). '
      + 'The run pauses and you get the answers in the next message.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({
      question: z.string().min(1).describe('Card title — one short question.'),
      description: z.string().optional().describe('One or two lines of context: what you found and why you ask.'),
      fields: z.array(fieldSchema).min(1).max(6),
      documentId: z.string().optional(),
      page: z.number().int().positive().optional().describe('Page the question is about (the app jumps there).'),
    }),
    execute: async (_context, input) => {
      const fields = sanitizeClarificationFields(
        input.fields.map(field => ({
          ...field,
          options: field.options?.map((option, i) => ({ id: `${field.id}_${i + 1}`, ...option })),
        })),
      );
      if (!fields.length) {
        return { status: 'failed', summary: 'ask_user needs at least one valid field.' };
      }
      return {
        status: 'completed',
        summary: `Asked the user: ${input.question}. Wait for the answer.`,
        output: { asked: input.question, fields: fields.map(field => field.id) },
        askUser: {
          question: input.question,
          ...(input.description ? { description: input.description } : {}),
          fields,
          ...(input.page ? { focus: { ...(input.documentId ? { documentId: input.documentId } : {}), page: input.page } } : {}),
        },
      };
    },
  };
}
