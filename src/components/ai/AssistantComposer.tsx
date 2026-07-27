import { ChatInput } from './ChatInput';
import { PulsingStatus } from './PulsingStatus';

export function AssistantComposer(props: {
  onSend: (message: string, images?: string[]) => void;
  onStop?: () => void;
  isLoading: boolean;
  disabled: boolean;
  contextChips: string[];
}) {
  return (
    <div className="space-y-2">
      {props.isLoading && (
        <div className="px-1">
          <PulsingStatus />
        </div>
      )}
      <ChatInput
        onSend={props.onSend}
        isLoading={props.isLoading}
        disabled={props.disabled}
        placeholder="Ask the agent… (tools, callouts, counts) or /takeoff"
        onStop={props.onStop}
        contextChips={props.contextChips}
      />
    </div>
  );
}
