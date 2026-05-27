import type { SupportedLanguage } from './session-manager'

export type GeneratedCode = {
  language: SupportedLanguage
  code: string
  timeoutMs?: number
}

export type MockUserMessage =
  | 'run a python loop'
  | 'list sandbox files'
  | 'run javascript hello'
  | 'trigger a python error'
  | 'run slow python code'
  | 'simulate memory failure'

const RESPONSES: Record<MockUserMessage, GeneratedCode> = {
  'run a python loop': {
    language: 'python',
    code: 'for i in range(3): print(f"step {i}")',
  },
  'list sandbox files': {
    language: 'python',
    code: 'from pathlib import Path\nprint([p.name for p in Path(".").iterdir()])',
  },
  'run javascript hello': {
    language: 'javascript',
    code: 'console.log("separate sandbox")',
  },
  'trigger a python error': {
    language: 'python',
    code: 'totals = {"revenue": 1200}\nprint(totals["profit"])',
  },
  'run slow python code': {
    language: 'python',
    code: 'import time\nprint("working..."); time.sleep(5)',
    timeoutMs: 1_000,
  },
  'simulate memory failure': {
    language: 'python',
    code: 'bytearray(2**63 - 1)',
  },
}

export async function mockGenerateCode(message: MockUserMessage): Promise<GeneratedCode> {
  return RESPONSES[message]
}
