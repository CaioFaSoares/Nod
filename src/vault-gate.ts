// K5/SP02 §9: the page's half of the gate — the decision between the operating system's prompt
// and the Nod password, and the fallback when a system prompt did not confirm. Settings → Vault and
// the embedded tab's "Sign in" control share this one definition; the prompt itself belongs to the
// screen that asks (Settings shows it inline on the card, `app.ts` in a dialog).
import { GATE_PASSWORD_REQUIRED, GATE_PROMPT_FAILED } from '../shared/types';

/**
 * What one gated action needs from its screen. `run` performs the action and records its failure
 * where `failure` can read it, because the gate's own answer is the action's error: the backend
 * speaks through `GATE_PROMPT_FAILED` and `GATE_PASSWORD_REQUIRED` (`docs/canonico.md` §22).
 */
export interface GateAction {
  /** runs the action; `password` undefined lets the backend run the system prompt itself */
  run: (password?: string) => Promise<void>;
  /** the error the action just left, or null when it succeeded */
  failure: () => string | null;
  /** the system prompt did not confirm: every later gate of this session takes the password */
  systemPromptFailed: () => void;
  /**
   * Shows the password prompt (the screen owns it) and resumes with the typed value, or with
   * `undefined` when the field was left empty. `note` explains a fallback, null a machine without
   * biometrics.
   */
  ask: (note: string | null, run: (password?: string) => Promise<void>) => void;
}

/** A gated action that first decides whether the machine offers the system prompt. */
export interface GateFlow extends GateAction {
  /** this session can use the operating system's prompt */
  systemPrompt: boolean;
}

/**
 * K5/SP02 §9: runs `flow.run` the way this machine allows. With the system prompt, the action runs
 * with no password and its failure decides (`attemptGate`); without it the prompt is the first
 * thing asked.
 */
export function runGate(flow: GateFlow): void {
  if (flow.systemPrompt) attemptGate(flow);
  else flow.ask(null, flow.run);
}

/**
 * K5/SP02 §9: runs the action with no password and lets the backend decide — an action it needs no
 * gate for just goes through. `GATE_PROMPT_FAILED` switches the session to the password
 * (`systemPromptFailed`) and re-opens the same action on the prompt; a call that needed a factor
 * and had none (`GATE_PASSWORD_REQUIRED`) asks for it. Either way the same action comes back on the
 * password prompt. A cancel, an empty field or a wrong password leaves the action undone.
 *
 * The action's failure is read after it resolves, exactly as `Settings → Vault` always read its own
 * status: a screen that ignores it (a successful copy, an ordinary error) is not asked again.
 */
export function attemptGate(action: GateAction): void {
  void action.run(undefined).then(() => {
    const failed = action.failure();
    if (failed === GATE_PROMPT_FAILED) {
      action.systemPromptFailed();
      action.ask('The system prompt did not confirm — use your Nod password instead', action.run);
    } else if (failed === GATE_PASSWORD_REQUIRED) {
      action.ask('This needs your password', action.run);
    }
  });
}
