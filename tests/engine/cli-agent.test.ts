import { describe, expect, test } from 'bun:test'

import { createCliStructuredOutputParser } from '../../src/ai/cli-agent'

describe('CLI structured output parser', () => {
  test('parses Codex JSONL progress items and final assistant text', () => {
    const deltas: string[] = []
    const reasoningStarts: Array<{ id: string; text?: string }> = []
    const reasoningDeltas: Array<{ id: string; delta: string }> = []
    const reasoningEnds: Array<{ id: string }> = []
    const started: Array<{ toolCallId: string; toolName: string; input?: unknown }> = []
    const completed: Array<{ toolCallId: string; toolName: string; output?: unknown; errorText?: string }> = []

    const parser = createCliStructuredOutputParser('codex-cli', {
      onAssistantDelta(delta) {
        deltas.push(delta)
      },
      onReasoningStart(entry) {
        reasoningStarts.push(entry)
      },
      onReasoningDelta(entry) {
        reasoningDeltas.push(entry)
      },
      onReasoningEnd(entry) {
        reasoningEnds.push(entry)
      },
      onToolStart(entry) {
        started.push(entry)
      },
      onToolComplete(entry) {
        completed.push(entry)
      }
    })

    parser.push('{"type":"item.started","item":{"id":"reason-1","type":"reasoning","summary":"Plan the implementation"}}\n')
    parser.push('{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"Planned the implementation"}}\n')
    parser.push('{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"node openpencil-tool.mjs render {\\"jsx\\":\\"<Frame />\\"}"}}\n')
    parser.push('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"node openpencil-tool.mjs render {\\"jsx\\":\\"<Frame />\\"}","aggregated_output":"{\\"id\\":\\"frame-1\\"}","exit_code":0}}\n')
    parser.push('{"type":"agent_message_delta","delta":"Building the layout... "}\n')
    parser.push('{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"Built the layout."}}\n')
    parser.flush()

    expect(started).toEqual([
      {
        toolCallId: 'reason-1',
        toolName: 'thinking_step',
        input: 'Plan the implementation'
      },
      {
        toolCallId: 'cmd-1',
        toolName: 'run_command',
        input: {
          command: 'node openpencil-tool.mjs render {"jsx":"<Frame />"}'
        }
      }
    ])
    expect(completed).toEqual([
      {
        toolCallId: 'reason-1',
        toolName: 'thinking_step',
        output: 'Planned the implementation'
      },
      {
        toolCallId: 'cmd-1',
        toolName: 'run_command',
        output: {
          command: 'node openpencil-tool.mjs render {"jsx":"<Frame />"}',
          exitCode: 0,
          output: '{"id":"frame-1"}'
        }
      }
    ])
    expect(reasoningStarts).toEqual([
      {
        id: 'reason-1',
        text: 'Plan the implementation'
      }
    ])
    expect(reasoningDeltas).toEqual([
      {
        id: 'reason-1',
        delta: 'ned the implementation'
      }
    ])
    expect(reasoningEnds).toEqual([
      {
        id: 'reason-1'
      }
    ])
    expect(deltas.join('')).toBe('Building the layout... Built the layout.')
    expect(parser.state.finalAssistantText).toBe('Built the layout.')
  })

  test('parses Codex item_type and assistant_message variants', () => {
    const deltas: string[] = []
    const replacements: string[] = []
    const started: Array<{ toolCallId: string; toolName: string; input?: unknown }> = []
    const completed: Array<{ toolCallId: string; toolName: string; output?: unknown; errorText?: string }> = []

    const parser = createCliStructuredOutputParser('codex-cli', {
      onAssistantDelta(delta) {
        deltas.push(delta)
      },
      onAssistantSnapshotReplace(text) {
        replacements.push(text)
      },
      onToolStart(entry) {
        started.push(entry)
      },
      onToolComplete(entry) {
        completed.push(entry)
      }
    })

    parser.push('{"type":"item.started","item":{"id":"reason-2","item_type":"reasoning","summary":"Compare the screenshots"}}\n')
    parser.push('{"type":"item.updated","item":{"id":"assistant-2","item_type":"assistant_message","content":[{"type":"text","text":"Inspecting the current page. "}]}}\n')
    parser.push('{"type":"item.completed","item":{"id":"reason-2","item_type":"reasoning","text":"Compared the screenshots"}}\n')
    parser.push('{"type":"item.completed","item":{"id":"assistant-2","item_type":"assistant_message","content":[{"type":"text","text":"Inspecting the current page. I found the main mismatch."}]}}\n')
    parser.flush()

    expect(started).toEqual([
      {
        toolCallId: 'reason-2',
        toolName: 'thinking_step',
        input: 'Compare the screenshots'
      }
    ])
    expect(completed).toEqual([
      {
        toolCallId: 'reason-2',
        toolName: 'thinking_step',
        output: 'Compared the screenshots'
      }
    ])
    expect(replacements).toEqual([])
    expect(deltas).toEqual(['Inspecting the current page. ', 'I found the main mismatch.'])
    expect(parser.state.finalAssistantText).toBe('Inspecting the current page. I found the main mismatch.')
  })

  test('emits assistant snapshot replacements when Codex rewrites technical progress text', () => {
    const deltas: string[] = []
    const replacements: string[] = []

    const parser = createCliStructuredOutputParser('codex-cli', {
      onAssistantDelta(delta) {
        deltas.push(delta)
      },
      onAssistantSnapshotReplace(text) {
        replacements.push(text)
      }
    })

    parser.push(
      '{"type":"item.updated","item":{"id":"assistant-3","item_type":"assistant_message","content":[{"type":"text","text":"Reading REQUEST.md and locating the current page."}]}}\n'
    )
    parser.push(
      '{"type":"item.updated","item":{"id":"assistant-3","item_type":"assistant_message","content":[{"type":"text","text":"Comparing the current page against the attached screenshot."}]}}\n'
    )
    parser.push(
      '{"type":"item.completed","item":{"id":"assistant-3","item_type":"assistant_message","content":[{"type":"text","text":"Comparing the current page against the attached screenshot. I found the main height mismatch."}]}}\n'
    )
    parser.flush()

    expect(deltas).toEqual([
      'Reading REQUEST.md and locating the current page.',
      ' I found the main height mismatch.'
    ])
    expect(replacements).toEqual([
      'Comparing the current page against the attached screenshot.'
    ])
    expect(parser.state.finalAssistantText).toBe(
      'Comparing the current page against the attached screenshot. I found the main height mismatch.'
    )
    expect(parser.state.latestAssistantSnapshotText).toBe(
      'Comparing the current page against the attached screenshot. I found the main height mismatch.'
    )
  })

  test('parses Claude stream-json partial assistant snapshots', () => {
    const deltas: string[] = []
    const parser = createCliStructuredOutputParser('claude-code', {
      onAssistantDelta(delta) {
        deltas.push(delta)
      }
    })

    parser.push('{"type":"system","subtype":"init"}\n')
    parser.push('{"type":"assistant","message":{"id":"claude-1","content":[{"type":"text","text":"Thinking"}]}}\n')
    parser.push('{"type":"assistant","message":{"id":"claude-1","content":[{"type":"text","text":"Thinking through the layout"}]}}\n')
    parser.push('{"type":"result","result":"Thinking through the layout"}\n')
    parser.flush()

    expect(deltas).toEqual(['Thinking', ' through the layout'])
    expect(parser.state.finalAssistantText).toBe('Thinking through the layout')
  })
})
