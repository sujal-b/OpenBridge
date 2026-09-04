Step 0 done. No commit — say word.  
What landed:

- bridge-read.js new → readJsonlTail cap-before-parse + parseCount, readJsonlPair parallel. Zero server deps.
- bridge.js → readEvents/readActions onto tail w/ TUI windows (256KB/120/160), render() 2 lanes (readState + pair), repair single-flight + 5s cooldown. Catch block untouched → empty-state survives.
- bridge-inspector.js → readSnapshot events/actions via pair (512KB uncapped). State path + warnings shape preserved. parseJsonLines export kept.
- test/bridge-read.test.js 6 tests → window, cap-before-parse, torn skip, malformed line no, ENOENT, TUI limits, TUI↔inspector parity.  
  Evidence:
- node --check ×3 clean
- bridge-read 6/6 green
- actions+inspector+latency+stage1 26/26 green incl e2e  
  2 spec gaps open, deliberate:
- empty-state render → readState ENOENT path untouched, catch unchanged. No unit seam for render(); covered by inspection, not test.
- repair single-spawn → guard logic in place, no spawn-count seam. Needs mock injection to test properly. Flagged for follow-up, not faked.  
  Next: bridge latency --clear → 20-30 chunks → decide #1 empirically.
-
