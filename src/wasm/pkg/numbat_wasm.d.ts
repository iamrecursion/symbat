export function setup_panic_hook(): void;
export enum FormatType {
  JqueryTerminal = 0,
  Html = 1,
}
export class CommandResult {
  private constructor();
  free(): void;
  is_command: boolean;
  should_clear: boolean;
  should_reset: boolean;
  readonly output: string;
}
export class InterpreterOutput {
  private constructor();
  free(): void;
  is_error: boolean;
  readonly output: string;
}
export class Numbat {
  private constructor();
  free(): void;
  print_info(keyword: string): unknown;
  /**
   * Try to run the input as a command.
   * Returns a CommandResult indicating whether the input was a command,
   * and if so, what output it produced and any side effects needed.
   */
  try_run_command(input: string): CommandResult;
  set_exchange_rates(xml_content: string): void;
  get_completions_for(input: string): unknown[];
  /**
   * Check if input ends with a unicode shortcut pattern (e.g., \alpha).
   * Returns [pattern_length, replacement] if found, or empty array if not.
   */
  get_unicode_completion(input: string): unknown[];
  static new: (load_prelude: boolean, enable_pretty_printing: boolean, format_type: FormatType) => Numbat;
  help(): unknown;
  interpret(code: string): InterpreterOutput;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_commandresult_free: (a: number, b: number) => void;
  readonly __wbg_get_commandresult_is_command: (a: number) => number;
  readonly __wbg_get_commandresult_should_clear: (a: number) => number;
  readonly __wbg_get_commandresult_should_reset: (a: number) => number;
  readonly __wbg_interpreteroutput_free: (a: number, b: number) => void;
  readonly __wbg_numbat_free: (a: number, b: number) => void;
  readonly __wbg_set_commandresult_is_command: (a: number, b: number) => void;
  readonly __wbg_set_commandresult_should_clear: (a: number, b: number) => void;
  readonly __wbg_set_commandresult_should_reset: (a: number, b: number) => void;
  readonly commandresult_output: (a: number) => [number, number];
  readonly interpreteroutput_output: (a: number) => [number, number];
  readonly numbat_get_completions_for: (a: number, b: number, c: number) => [number, number];
  readonly numbat_get_unicode_completion: (a: number, b: number, c: number) => [number, number];
  readonly numbat_help: (a: number) => unknown;
  readonly numbat_interpret: (a: number, b: number, c: number) => number;
  readonly numbat_new: (a: number, b: number, c: number) => number;
  readonly numbat_print_info: (a: number, b: number, c: number) => unknown;
  readonly numbat_set_exchange_rates: (a: number, b: number, c: number) => void;
  readonly numbat_try_run_command: (a: number, b: number, c: number) => number;
  readonly setup_panic_hook: () => void;
  readonly __wbg_get_interpreteroutput_is_error: (a: number) => number;
  readonly __wbg_set_interpreteroutput_is_error: (a: number, b: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_3: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

export function __numbat_reset(): void;
