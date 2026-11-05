## Notes on this round

- The meter changed once during this round, the same way for both sides. G1's final page recovers a lost WebGL context by reloading itself, a valid recovery. The context-restore probe ran inside the desktop session, so the reload ended that session and failed every desktop check of the page (brief 23/33 and motion 17/27 for Geno at first). The probe now runs in its own session and counts a reload that brings the hero back as a recovery. A fixture that reloads (`fixtures/reloads`) passes 30/30. Every l2 page was then measured again. No l1 page listens for `webglcontextrestored`, so the change moves no l1 number.
- Judge stability was not measured again (`--stability 0`); l1 measured it (8 of 9 pairs the same on a second judging). That kept the round under its $10 budget.
- The simulated user's "go on" is English in this round for both harnesses. In l1 it was Thai, and Geno answered those segments in Thai.
