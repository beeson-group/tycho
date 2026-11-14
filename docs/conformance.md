```{include} ../spec/conformance/README.md
```

The conformance corpus is kept in [`spec/conformance/`](https://github.com/beeson-group/tycho/tree/main/spec/conformance) in the repository.
The Python suite runs it with `pytest tests/test_conformance.py`, and the TypeScript suite runs it with `npm test` in `web/`.
Both suites run the same cases, hence the Python and the TypeScript evaluators are held to the same answers.
