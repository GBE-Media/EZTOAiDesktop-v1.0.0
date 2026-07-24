import { ChatInput } from './ChatInput';

export function AssistantComposer(props: {
  onSend: (message: string, images?: string[]) => void;
  onStop?: () => void;
  isLoading: boolean;
  disabled: boolean;
  contextChips: string[];
}) {
  return (
    <ChatInput
      onSend={props.onSend}
      isLoading={props.isLoading}
      disabled={props.disabled}
      placeholder="Ask about this bid, /takeoff, or attach evidence..."
      onStop={props.onStop}
      contextChips={props.contextChips}
    />
  );
}
