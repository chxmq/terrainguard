# Terrain Guard
#   make          → install (if needed) + run backend + frontend
#   make help     → list all commands
#   make demo     → single URL on :8000 (production build, no hot reload)

.DEFAULT_GOAL := dev

BACKEND_DIR  := backend
FRONTEND_DIR := frontend
VENV         := $(BACKEND_DIR)/.venv
PY           := $(VENV)/bin/python
PIP          := $(VENV)/bin/pip
UVICORN      := $(VENV)/bin/uvicorn
PYTEST       := $(VENV)/bin/pytest

PYTHON    ?= python3
PORT      ?= 8000
VITE_PORT ?= 5173
IMAGE     ?= terrain-guard

.PHONY: help install setup venv backend-install frontend-install \
        dev start dev-backend dev-frontend build run demo demo-preload \
        test check validate validate-global benchmark \
        docker-build docker-run clean clean-all

help: ## Show available targets
	@echo "Terrain Guard"
	@echo ""
	@echo "  make               Run the whole project (same as: make dev)"
	@echo "  make dev           API :$(PORT) + app :$(VITE_PORT) with hot reload"
	@echo "  make demo          Everything on one URL → http://127.0.0.1:$(PORT)"
	@echo "  make install       Dependencies only (venv + npm)"
	@echo "  make test          Backend pytest suite"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: venv frontend-install ## Install backend + frontend dependencies
	@echo "✓ Dependencies ready."

setup: install ## Alias for install

venv: $(PY) ## Create backend virtualenv and pip install

$(PY): $(BACKEND_DIR)/requirements.txt
	$(PYTHON) -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt

backend-install: venv ## Install Python dependencies only

frontend-install: $(FRONTEND_DIR)/node_modules ## Install npm dependencies

$(FRONTEND_DIR)/node_modules: $(FRONTEND_DIR)/package.json $(FRONTEND_DIR)/package-lock.json
	cd $(FRONTEND_DIR) && npm install

dev start: install ## Run backend + frontend (default: make)
	@echo ""
	@echo "  Terrain Guard is running"
	@echo "  → Open http://127.0.0.1:$(VITE_PORT)  (use this in the browser)"
	@echo "  → API  http://127.0.0.1:$(PORT)"
	@echo "  Ctrl+C to stop"
	@echo ""
	@trap 'kill 0' INT TERM; \
	cd $(BACKEND_DIR) && .venv/bin/uvicorn main:app --reload --host 127.0.0.1 --port $(PORT) & \
	cd $(FRONTEND_DIR) && npm run dev -- --host 127.0.0.1 --port $(VITE_PORT) & \
	wait

dev-backend: venv ## FastAPI only (with auto-reload)
	cd $(BACKEND_DIR) && .venv/bin/uvicorn main:app --reload --host 127.0.0.1 --port $(PORT)

dev-frontend: frontend-install ## Vite only (proxies /api → backend)
	cd $(FRONTEND_DIR) && npm run dev -- --host 127.0.0.1 --port $(VITE_PORT)

build: frontend-install ## Build production SPA → frontend/dist
	cd $(FRONTEND_DIR) && npm run build

run: demo ## Alias for demo

demo: build venv ## Single-origin app at http://127.0.0.1:8000
	@echo "→ http://127.0.0.1:$(PORT)  (API + built frontend, one URL)"
	cd $(BACKEND_DIR) && .venv/bin/uvicorn main:app --host 127.0.0.1 --port $(PORT)

demo-preload: build venv ## Demo with Ladakh preloaded (TTCI_PRELOAD=1)
	@echo "→ http://127.0.0.1:$(PORT)  (preloaded TTCI surface)"
	cd $(BACKEND_DIR) && TTCI_PRELOAD=1 .venv/bin/uvicorn main:app --host 127.0.0.1 --port $(PORT)

test: venv ## Run backend tests (pytest)
	cd $(BACKEND_DIR) && .venv/bin/pytest tests/ -q

check: test build ## Tests + frontend production build

validate: venv ## Regenerate CFIT validation report (network; slow)
	cd $(BACKEND_DIR) && .venv/bin/python validate_ttci.py

validate-global: venv ## Regenerate global CFIT validation report (network; slow)
	cd $(BACKEND_DIR) && .venv/bin/python validate_ttci_global.py

benchmark: venv ## TTCI throughput benchmark
	cd $(BACKEND_DIR) && .venv/bin/python benchmark.py

docker-build: ## Build production Docker image
	docker build -t $(IMAGE) .

docker-run: docker-build ## Run production image locally
	docker run --rm -p $(PORT):8000 -e TTCI_SOURCE=tiles $(IMAGE)

clean: ## Remove caches and frontend/dist
	rm -rf $(BACKEND_DIR)/.pytest_cache $(BACKEND_DIR)/.hypothesis
	find $(BACKEND_DIR) -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf $(FRONTEND_DIR)/dist $(FRONTEND_DIR)/.vite

clean-all: clean ## Also remove .venv and node_modules
	rm -rf $(VENV) $(FRONTEND_DIR)/node_modules
