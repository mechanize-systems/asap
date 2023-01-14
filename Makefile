SRC = $(wildcard src/*.ts) $(wildcard src/*.tsx)
LIB0 = $(SRC:src/%.ts=lib/%.js)
LIB = $(LIB0:src/%.tsx=lib/%.js)
DTS = $(LIB:%.js=%.d.ts)
DTS0 = $(DTS:lib/%=node_modules/.cache/tsbuild/src/%)

.PHONY: build
build: api.js main.js $(LIB) $(DTS)

.PHONY: check
check $(DTS0):
	@pnpm tsc -b .

.PHONY: test
test:
	@pnpm playwright test -j1

.PHONY: clean
clean:
	rm -rf lib main.js api.js

.PHONY: fmt
fmt:
	@pnpm prettier --write .

.envrc:
	echo 'layout nodenv 16.13.2' > $@
	echo 'export PROJECT__ROOT="$$PWD"' >> $@
	echo 'PATH_add "$$PROJECT__ROOT/.bin"' >> $@

main.js: $(wildcard bin/*) $(wildcard base/*) pnpm-lock.yaml
	@mkdir -p $(@D)
	@pnpm esbuild \
		--bundle \
		--sourcemap=inline \
		--platform=node \
		--external:esbuild \
		--external:fb-watchman \
		--external:socket-activation \
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
