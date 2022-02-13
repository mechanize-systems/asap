SRC = $(wildcard src/*.ts) $(wildcard src/*.tsx)
LIB0 = $(SRC:src/%.ts=lib/%.js)
LIB = $(LIB0:src/%.tsx=lib/%.js)
DTS = $(LIB:%.js=%.d.ts)

.PHONY: build
build: api.js main.js $(LIB) $(DTS)

.PHONY: check
check:
	@pnpm tsc -b .

.PHONY: clean
clean:
	rm -rf lib main.js

main.js: $(wildcard bin/*) pnpm-lock.yaml
	@mkdir -p $(@D)
	@pnpm esbuild \
		--bundle \
		--sourcemap=inline \
		--platform=node \
		--external:esbuild \
		--external:fb-watchman \
		--log-level=error \
		--outfile=$@ ./bin/main.ts
	@chmod +x $@

api.js: $(wildcard src/*)
	@mkdir -p $(@D)
	@pnpm esbuild \
		--bundle \
		--sourcemap=inline \
		--platform=node \
		--log-level=error \
		--outfile=$@ src/api.ts

lib/%.js: src/%.ts
	@mkdir -p $(@D)
	@pnpm esbuild \
		--platform=browser \
		--log-level=error \
		--outfile=$@ $<

lib/%.js: src/%.tsx
	@mkdir -p $(@D)
	@pnpm esbuild \
		--platform=browser \
		--log-level=error \
		--outfile=$@ $<

lib/%.d.ts: node_modules/.cache/tsbuild/src/%.d.ts
	@mkdir -p $(@D)
	@cp $< $@
