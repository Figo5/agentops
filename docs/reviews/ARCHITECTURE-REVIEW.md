# Architecture review resolutions

Claude Opus 5 reviewed the implementation read-only through Claude Code at high effort. Its first architecture verdict was REJECT. The following findings were addressed before final acceptance:

- Manual sessions now return an explicit input wait before awaiting a submitted result. HTTP integration tests exercise the complete engine path.
- Runtime adapters validate agent-declared artifacts with canonical containment and filesystem checks before accepting the result. Escaping symlinks fail the attempt; unknown existence is not asserted by core storage.
- Structured results, verdicts, audit events and prompt packet fields are redacted at the storage boundary. Regression tests inspect persisted records, not only rendered output.
- Pending human approval attempts survive restart unchanged; active execution attempts become interrupted.
- APPROVE_WITH_FIXES requires actionable issues. Reviewer JSON extraction accepts the documented fenced or prefaced response.
- Input is delivered before the run resumes. Malformed manual input leaves the gate open and records delivery failure.
- Verification uses the frozen run command policy. Retry checks the project lease explicitly. Git writes cannot occur while a human gate is open. Unknown adapters fail closed.
- Driver status polling is bounded at 50 ms rather than 2 ms.

Template version 2 additionally includes explicit planning, final verification after review, and a research experiment stage. Existing runs retain their frozen plans. See ACCEPTANCE.md for the final checks and reviewer disposition.
