import { SandboxSessionManager } from './session-manager'
import { mockGenerateCode, type GeneratedCode } from './mock-code-generator'

// Demo configuration mirrors the customer scenario: one isolated runtime per
// conversation, with short per-command limits and longer session idle cleanup.
const session = new SandboxSessionManager({
  sandboxTimeoutMs: 10 * 60 * 1000,
  commandTimeoutMs: 30 * 1000,
})
const lifecycleFailures: string[] = []

async function main() {
  // package.json loads .env with Node's --env-file flag for local runs.
  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY is required. Copy .env.example to .env before running npm run demo.')
  }

  try {
    // Turn 1 creates a brand-new sandbox for conv-1.
    console.log('Turn 1: Python in a new conversation')
    const turn1 = await session.execute('conv-1', toExecutionRequest(await mockGenerateCode('run a python loop')))
    console.log(`\nconv-1 sandbox: ${turn1.sandboxId}`)
    if (!turn1.ok || !turn1.sandboxId) {
      console.log(`Unable to start the first sandbox: ${turn1.error ?? turn1.stderr}`)
      console.log('Skipping follow-up lifecycle checks because E2B is not reachable or sandbox creation failed.')
      return
    }
    check(turn1.ok, 'turn 1 should execute successfully')
    check(Boolean(turn1.sandboxId), 'turn 1 should create a sandbox')

    // Turn 2 uses the same conversationId, so the same sandbox is reused and
    // filesystem state from turn 1 is still visible.
    console.log('\nTurn 2: Same conversation, same sandbox, filesystem state persists')
    const turn2 = await session.execute('conv-1', toExecutionRequest(await mockGenerateCode('list sandbox files')))
    check(turn2.ok, 'turn 2 should execute successfully')
    check(turn2.sandboxId === turn1.sandboxId, 'conv-1 follow-up should reuse the same sandbox')
    console.log(`\nconv-1 sandbox reused: ${turn2.sandboxId === turn1.sandboxId}`)

    // A different conversation gets a different sandbox. This demonstrates the
    // same isolation boundary they previously got from one ECS container per session.
    console.log('\nTurn 3: Different conversation, different sandbox')
    const turn3 = await session.execute('conv-2', toExecutionRequest(await mockGenerateCode('run javascript hello')))
    check(turn3.ok, 'turn 3 should execute successfully')
    check(Boolean(turn3.sandboxId), 'turn 3 should create a sandbox')
    check(turn3.sandboxId !== turn1.sandboxId, 'conv-2 should get a different sandbox')
    console.log(`\nconv-2 sandbox: ${turn3.sandboxId}`)
    console.log(`conv-2 is separate: ${turn3.sandboxId !== turn1.sandboxId}`)

    // Bad generated code should return a failed execution result, not crash the
    // backend worker that is managing all user conversations.
    console.log('\nTurn 4: Bad code returns a failed result instead of crashing the process')
    const bad = await session.execute('conv-1', toExecutionRequest(await mockGenerateCode('trigger a python error')))
    check(!bad.ok, 'bad generated code should fail')
    check(bad.errorType === 'execution_error', 'bad generated code should be classified as execution_error')
    console.log(`\nok: ${bad.ok}`)
    console.log(`errorType: ${bad.errorType}`)
    console.log(`error: ${bad.error ?? bad.stderr}`)

    console.log('\nTurn 5: Long-running code is classified as a timeout')
    const timeout = await session.execute('conv-1', toExecutionRequest(await mockGenerateCode('run slow python code')))
    check(!timeout.ok, 'long-running code should fail')
    check(timeout.errorType === 'timeout', 'long-running code should be classified as timeout')
    console.log(`\nok: ${timeout.ok}`)
    console.log(`errorType: ${timeout.errorType}`)
    console.log(`error: ${timeout.error ?? timeout.stderr}`)

    console.log('\nTurn 6: Memory failures are classified as out_of_memory')
    const oom = await session.execute('conv-1', toExecutionRequest(await mockGenerateCode('simulate memory failure')))
    check(!oom.ok, 'memory failure should fail')
    check(oom.errorType === 'out_of_memory', 'memory failure should be classified as out_of_memory')
    console.log(`\nok: ${oom.ok}`)
    console.log(`errorType: ${oom.errorType}`)
    console.log(`error: ${oom.error ?? oom.stderr}`)

    console.log('\nSession summary')
    const summary = session.listSessions()
    console.table(summary)

    const conv1 = summary.find((item) => item.conversationId === 'conv-1')
    const conv2 = summary.find((item) => item.conversationId === 'conv-2')
    check(summary.length === 2, 'there should be one live session per conversation')
    check(conv1?.sandboxId === turn1.sandboxId, 'conv-1 summary should keep the reused sandbox id')
    check(conv1?.turnCount === 5, 'conv-1 should have five execution turns')
    check(conv2?.sandboxId === turn3.sandboxId, 'conv-2 summary should keep its own sandbox id')
    check(conv2?.turnCount === 1, 'conv-2 should have one execution turn')

    await session.disposeAll()
    check(session.listSessions().length === 0, 'disposeAll should remove all tracked sessions')
    if (lifecycleFailures.length === 0) {
      console.log('\nLifecycle checks passed')
    } else {
      console.log('\nLifecycle checks completed with failures')
      for (const failure of lifecycleFailures) console.log(`- ${failure}`)
      process.exitCode = 1
    }
  } finally {
    // Explicit cleanup for the demo. In production this would also happen on
    // conversation close, logout, worker shutdown, or idle timeout.
    await session.disposeAll()
  }
}

main().catch(async (error) => {
  // Last-resort cleanup if setup or a sandbox request fails before the finally block.
  console.error(error)
  await session.disposeAll()
  process.exitCode = 1
})

function check(condition: unknown, message: string): void {
  if (condition) return
  lifecycleFailures.push(message)
  console.warn(`Lifecycle check failed: ${message}`)
}

function toExecutionRequest(generated: GeneratedCode) {
  return {
    ...generated,
    onStdout: (line: string) => process.stdout.write(line),
    onStderr: (line: string) => process.stderr.write(line),
  }
}
