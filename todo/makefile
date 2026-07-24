all: model

../tools/gen_ts.py: ../tools/protos.py ../tools/skeleton.ts
	@touch $@

../tools/gen_go.py: ../tools/protos.py ../tools/skeleton.go
	@touch $@

.PHONY: model
model: model/node_modules model/model.gen.ts

model/node_modules:
	cd model && pnpm i

model/model.gen.ts: model/model.py ../tools/gen_ts.py model/reducers.ts model/tsconfig.json
	python ../tools/protos.py -i ../tools -i model gen_ts model > $@

.PHONY: model/check
model/check: model
	cd model && pnpm tsc

.PHONY: relay
relay: relay/relay

relay/relay.js: model/node_modules model/model.gen.ts model/relay.ts
	cd model && pnpm rollup -m inline --format=cjs -p typescript relay.ts -o ../relay/relay.js

relay/model/model.go: model/model.py ../tools/gen_go.py
	mkdir -p relay/model
	python ../tools/protos.py -i ../tools -i model gen_go model -- model > $@

relay/relay: relay/relay.js relay/main.go relay/model/model.go
	cd relay && go build -o relay .

.PHONY: ui
ui: ui/node_modules ui/src/model.js ui/src/model.d.ts

ui/node_modules:
	cd ui && pnpm i

ui/src/model.js: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

ui/src/model.d.ts: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: ui/check
ui/check: ui
	cd ui && pnpm tsc

.PHONY: rsc
rsc: rsc/node_modules rsc/src/model.js rsc/src/model.d.ts
	cd rsc && pnpm build

rsc/node_modules:
	cd rsc && pnpm i

rsc/src/model.js: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

rsc/src/model.d.ts: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: rsc/check
rsc/check: rsc
	cd rsc && pnpm tsc

.PHONY: kesq
kesq: kesq/node_modules kesq/src/model.js kesq/src/model.d.ts
	cd kesq && pnpm build

kesq/node_modules:
	cd kesq && pnpm i

kesq/src/model.js: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

kesq/src/model.d.ts: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: kesq/check
kesq/check: kesq
	cd kesq && pnpm tsc

.PHONY: kesq2
kesq2: kesq2/node_modules kesq2/src/model.js kesq2/src/model.d.ts
	cd kesq2 && pnpm build

kesq2/node_modules:
	cd kesq2 && pnpm i

kesq2/src/model.js: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

kesq2/src/model.d.ts: model/node_modules model/model.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: kesq2/check
kesq2/check: kesq2
	cd kesq2 && pnpm tsc

.PHONY: check
check: relay/relay model/check ui/check rsc/check kesq/check kesq2/check

.PHONY: serve
serve: ui
	cd ui && pnpm serve

clean:
	@rm -f model/mode.gen.ts \
		relay/relay relay/model/model.go \
		ui/src/model.js ui/src/model.d.ts \
		rsc/src/model.js rsc/src/model.d.ts \
		kesq/src/model.js kesq/src/model.d.ts \
		kesq2/src/model.js kesq2/src/model.d.ts
	@rm -rf rsc/dist kesq/dist kesq2/dist
