.PHONY: chat

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
AGENT := $(word 2,$(MAKECMDGOALS))
AGENT_PATH := $(if $(AGENT),$(if $(wildcard $(ROOT_DIR)/agents/$(AGENT)/agent.yaml),$(ROOT_DIR)/agents/$(AGENT),$(AGENT)))

ifneq ($(AGENT),)
.PHONY: $(AGENT)
$(AGENT):
	@:
endif

chat:
	@"$(ROOT_DIR)/node_modules/.bin/tsx" "$(ROOT_DIR)/packages/engine/src/cli.ts" $(if $(AGENT_PATH),"$(AGENT_PATH)") --user-id user_feng $(CHAT_ARGS)

%:
	@:
