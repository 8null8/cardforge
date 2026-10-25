import json, sys, collections
a = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
b = [json.loads(l) for l in open(sys.argv[2], encoding="utf-8") if l.strip()]
assert len(a) == len(b), (len(a), len(b))
kinds = collections.Counter(); examples = collections.defaultdict(list)
ok = 0; errs_both = 0
for x, y in zip(a, b):
    assert x["url"] == y["url"]
    if "error" in x or "error" in y:
        if "error" in x and "error" in y:
            errs_both += 1
            continue
        k = "py-error-only" if "error" in x else "js-error-only"
        kinds[k] += 1; examples[k].append((x["url"], x.get("error") or y.get("error")))
        continue
    cx, cy = x["card"], y["card"]
    diff = False
    for f in sorted(set(cx) | set(cy)):
        if cx.get(f) != cy.get(f):
            diff = True
            kinds["field:" + f] += 1
            if len(examples["field:" + f]) < 6:
                examples["field:" + f].append((x["url"], cx.get(f), cy.get(f)))
    if x["warn"] != y["warn"]:
        kinds["warnings"] += 1
        if len(examples["warnings"]) < 5: examples["warnings"].append((x["url"], x["warn"], y["warn"]))
    if not diff: ok += 1
print(f"{len(a)} links: {ok} identical cards, {errs_both} fail in both")
for k, n in kinds.most_common():
    print(f"\n== {k}: {n}")
    for ex in examples[k][:4]:
        s = repr(ex)
        print("   ", s[:700])
