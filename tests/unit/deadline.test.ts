import { describe, expect, it } from 'vitest';
import { withDeadline } from '@/core/deadline.ts';

/**
 * The deadline's whole job is to make silence distinguishable from an answer.
 *
 * That matters because of what it wraps: the browser simply stops answering certain
 * calls for a page it does not consider visible, and an unsettled promise has no handler
 * and no error — it reads exactly like a hang. So the three cases worth pinning down are
 * "the answer arrived", "nothing arrived", and "a refusal arrived", and the last of those
 * must not be quietly turned into the first.
 */

const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withDeadline', () => {
  it('passes through an answer that arrives in time', async () => {
    const value = await withDeadline(Promise.resolve('answered'), 1000, () => 'expired');
    expect(value).toBe('answered');
  });

  it('expires on its own when nothing ever answers', async () => {
    const started = Date.now();
    const value = await withDeadline(never(), 20, () => 'expired');
    expect(value).toBe('expired');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('lets a refusal through rather than masking it with the fallback', async () => {
    // The distinction is the point: "the browser said no" and "the browser said nothing"
    // are different facts, and a caller that wanted to handle the first would never see
    // it if the fallback swallowed it.
    const refusal = Promise.reject(new Error('nope'));
    await expect(withDeadline(refusal, 1000, () => 'expired')).rejects.toThrow('nope');
  });

  it('reports an error when the caller refuses to fall back', async () => {
    // How the client turns an unanswered probe into a real, visible failure.
    await expect(
      withDeadline(never(), 20, () => {
        throw new Error('识别超时');
      }),
    ).rejects.toThrow('识别超时');
  });

  it('keeps the first answer, and stays settled afterwards', async () => {
    // A late answer must not be able to overwrite the value already handed out. In the
    // probe that would mean a profile appearing under a card that had already been told
    // something else.
    let releases: ((v: string) => void) | undefined;
    const late = new Promise<string>((resolve) => {
      releases = resolve;
    });

    const value = await withDeadline(late, 20, () => 'expired');
    expect(value).toBe('expired');

    releases!('too late');
    await sleep(20);
    expect(value).toBe('expired');
  });
});
