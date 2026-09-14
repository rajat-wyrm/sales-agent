import { coalesceEvents, isLeadLifecycleEvent, shouldRefreshLeadDetail } from './useSSE';
describe('coalesce', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  test('burst -> one call with last event', () => {
    const cb = jest.fn();
    const w = coalesceEvents(cb, 100);
    w({ type: 'lead_updated', lead_id: 'a' });
    w({ type: 'lead_updated', lead_id: 'b' });
    w({ type: 'enrichment_complete', lead_id: 'c' });
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(150);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ type: 'enrichment_complete', lead_id: 'c' });
  });
  test('second burst fires again', () => {
    const cb = jest.fn(); const w = coalesceEvents(cb, 100);
    w({ type: 'lead_updated' }); jest.advanceTimersByTime(150);
    w({ type: 'lead_updated' }); jest.advanceTimersByTime(150);
    expect(cb).toHaveBeenCalledTimes(2);
  });
  test('event predicates', () => {
    expect(isLeadLifecycleEvent('heartbeat')).toBe(false);
    expect(isLeadLifecycleEvent('connected')).toBe(false);
    expect(isLeadLifecycleEvent('enrichment_queued')).toBe(true);
    expect(shouldRefreshLeadDetail({ type: 'lead_updated', lead_id: 'x' }, 'x')).toBe(true);
    expect(shouldRefreshLeadDetail({ type: 'lead_updated', lead_id: 'y' }, 'x')).toBe(false);
  });
});
