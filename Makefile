.PHONY: chat

SCENARIO := $(word 2,$(MAKECMDGOALS))

chat:
	@if [ -z "$(SCENARIO)" ]; then \
		echo "Usage: make chat <scenario>"; \
		echo "Optional: make chat <scenario> CHAT_ARGS='--message \"你好\" --no-stream'"; \
		echo "Scenarios: investment-advisor, maintenance, presales"; \
		exit 2; \
	fi; \
	case "$(SCENARIO)" in \
		investment-advisor) \
			workflow="scenarios/investment-advisor/advisor_investment_research.workflow.ts"; \
			connectors="scenarios/investment-advisor/connectors.ts"; \
			user_id="user_feng"; \
			node -r dotenv/config -e 'const missing = ["PAC_INVESTMENT_ADVISOR_MCP_URL", "PAC_INVESTMENT_ADVISOR_MCP_AUTHORIZATION"].filter((key) => !process.env[key]?.trim()); if (missing.length) { console.error("Missing investment advisor MCP env: " + missing.join(", ")); console.error("Set them in .env or export them before running make chat investment-advisor."); process.exit(2); }' || exit $$?; \
			;; \
		maintenance) \
			workflow="scenarios/maintenance/maintenance_booking.workflow.ts"; \
			connectors="scenarios/maintenance/connectors.ts"; \
			user_id="user_feng"; \
			;; \
		presales) \
			workflow="scenarios/presales/presales_consultation.workflow.ts"; \
			connectors="scenarios/presales/connectors.ts"; \
			user_id="user_feng"; \
			;; \
		*) \
			echo "Unknown scenario: $(SCENARIO)"; \
			echo "Scenarios: investment-advisor, maintenance, presales"; \
			exit 2; \
			;; \
	esac; \
	npm run chat -- --workflow "$$workflow" --connectors "$$connectors" --user-id "$$user_id" $(CHAT_ARGS)

%:
	@:
