import type {
  CanvasPlacement,
  ChatMarkupPointer,
  PlacementMarkup,
} from './providers/types';

export const AI_CALLOUT_STYLE: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  fontSize: 12,
  fontFamily: 'Arial',
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

const estimateBubbleSize = (content: string) => {
  const lines = content.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: clamp(longest * 7 + 16, 72, 220),
    height: clamp(lines.length * 16 + 12, 28, 96),
  };
};

/**
 * Convert intentional chat callout pointers into classic callout markups
 * with a labeled bubble and a leader line to the target point/bounds.
 */
export function chatPointersToGreenPlacements(options: {
  pointers: ChatMarkupPointer[];
  page: number;
  pageWidth: number;
  pageHeight: number;
  idPrefix: string;
}): CanvasPlacement {
  const { pointers, page, pageWidth, pageHeight, idPrefix } = options;

  return {
    markups: pointers.map((pointer, index): PlacementMarkup => {
      const ref = pointer.ref || index + 1;
      const label = pointer.label?.trim() || `Callout ${ref}`;
      const content = `[${ref}] ${label}`;
      const bubble = estimateBubbleSize(content);

      const targetX = pointer.boundsPct
        ? ((pointer.boundsPct.x + pointer.boundsPct.width / 2) / 100) * pageWidth
        : (pointer.xPct / 100) * pageWidth;
      const targetY = pointer.boundsPct
        ? ((pointer.boundsPct.y + pointer.boundsPct.height / 2) / 100) * pageHeight
        : (pointer.yPct / 100) * pageHeight;

      const preferredX = targetX + 28;
      const preferredY = targetY - bubble.height - 24;
      const bubbleX = clamp(preferredX, 4, Math.max(4, pageWidth - bubble.width - 4));
      const bubbleY = clamp(preferredY, 4, Math.max(4, pageHeight - bubble.height - 4));

      // Leader attaches near the bubble corner closest to the target.
      const leaderStart = {
        x: bubbleX + (targetX < bubbleX ? 0 : bubble.width),
        y: bubbleY + (targetY < bubbleY ? 0 : bubble.height),
      };
      const leaderEnd = {
        x: clamp(targetX, 0, pageWidth),
        y: clamp(targetY, 0, pageHeight),
      };

      return {
        id: `${idPrefix}_callout_${ref}`,
        type: 'callout',
        page,
        points: [
          { x: bubbleX, y: bubbleY },
          { x: bubbleX + bubble.width, y: bubbleY + bubble.height },
        ],
        style: AI_CALLOUT_STYLE,
        label,
        content,
        leaderPoints: [leaderStart, leaderEnd],
        calloutRef: ref,
        aiNote: pointer.note,
        confidence: pointer.confidence,
        pending: true,
      };
    }),
    notes: [],
  };
}

/**
 * Ensure each intentional callout has a visible [N] mention in the answer text.
 */
export function ensureNumberedCalloutMentions(
  text: string,
  pointers: ChatMarkupPointer[]
): string {
  if (!pointers.length) return text;
  let next = text.trim();
  const missing: string[] = [];

  for (const [index, pointer] of pointers.entries()) {
    const ref = pointer.ref || index + 1;
    const mention = `[${ref}]`;
    if (!next.includes(mention)) {
      missing.push(`${mention} ${pointer.label?.trim() || `Callout ${ref}`}`);
    }
  }

  if (missing.length === 0) return next;
  return `${next}\n\nCallouts: ${missing.join('; ')}`;
}
