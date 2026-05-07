// src/test/unit/streamChatEmptyCompletion.test.ts
//
// Tests for the V2.1.2 "silent termination" fix in streamChat. The
// scenario: Qwen 3.6 27B at the lab endpoint returns 200 OK with no
// completion content when the prompt+context exceeds the 32K context
// window. Before this fix, the for-await-stream loop would yield
// zero chunks, streamChat would return success, and the user would
// see "Analyzing evidence..." followed by silence.
//
// We assert:
//   1. Zero chunks → throws EmptyCompletionError
//   2. Empty-string chunks (provider yields '' but no real content)
//      → throws EmptyCompletionError. (Defensive — this hasn't been
//      observed in practice but the buffer-flush path could
//      theoretically yield empty strings.)
//   3. At least one non-empty chunk → no throw, onToken receives it

const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn()
};

jest.mock('../../llm', () => {
    const actual = jest.requireActual('../../llm');
    return {
        ...actual,
        getProvider: async () => mockProvider
    };
});

// Audit logger is async and side-effecting; stub it out so tests
// don't touch disk.
jest.mock('../../container', () => ({
    getDeps: () => ({
        audit: {
            logLlmCall: jest.fn().mockResolvedValue(undefined),
        },
    }),
}));

import { streamChat, EmptyCompletionError } from '../../llmService';

/**
 * Build an async iterable that yields the given chunks. Mirrors the
 * shape returned by `provider.streamCompletion`.
 */
async function* chunkStream(chunks: string[]): AsyncGenerator<string> {
    for (const c of chunks) {
        yield c;
    }
}

describe('streamChat — empty completion handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('throws EmptyCompletionError when the provider yields zero chunks', async () => {
        mockProvider.streamCompletion.mockResolvedValueOnce(chunkStream([]));
        const tokens: string[] = [];
        await expect(
            streamChat('What is X?', '', [], (t) => tokens.push(t))
        ).rejects.toThrow(EmptyCompletionError);
        expect(tokens).toEqual([]);
    });

    it('throws EmptyCompletionError when all yielded chunks are empty strings', async () => {
        mockProvider.streamCompletion.mockResolvedValueOnce(chunkStream(['', '', '']));
        // Empty chunks STILL get forwarded to onToken (so consumers
        // that expected a stream of any kind still see the iteration),
        // but the throw fires after the loop because no non-empty
        // chunk was observed.
        const tokens: string[] = [];
        await expect(
            streamChat('What is X?', '', [], (t) => tokens.push(t))
        ).rejects.toThrow(EmptyCompletionError);
    });

    it('does NOT throw when at least one non-empty chunk is yielded', async () => {
        mockProvider.streamCompletion.mockResolvedValueOnce(chunkStream(['Hello', ' world']));
        const tokens: string[] = [];
        await expect(
            streamChat('What is X?', '', [], (t) => tokens.push(t))
        ).resolves.toBeUndefined();
        expect(tokens).toEqual(['Hello', ' world']);
    });

    it('exposes a meaningful error message hinting at context overflow', async () => {
        mockProvider.streamCompletion.mockResolvedValueOnce(chunkStream([]));
        try {
            await streamChat('X?', '', [], () => undefined);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(EmptyCompletionError);
            const msg = (e as Error).message.toLowerCase();
            // Message should give the user something to act on, not
            // just say "empty response".
            expect(msg).toMatch(/context|prompt|shorter|narrow/);
        }
    });
});