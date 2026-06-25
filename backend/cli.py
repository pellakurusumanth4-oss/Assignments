"""Quick CLI harness to exercise the agent loop without the web server.

Usage:
  python cli.py "I want a refund for order ord_1001, my email is alice.nguyen@example.com"
  python cli.py            # interactive REPL

Events are printed live so you can see the agent's reasoning trace in the terminal.
"""

from __future__ import annotations

import asyncio
import sys

from dotenv import load_dotenv

load_dotenv()

from refund_agent.agent import run_agent  # noqa: E402  (after load_dotenv so env is set)

ICONS = {
    "user_message": "🧑", "agent_message": "🤖", "tool_call": "🔧", "tool_result": "📦",
    "guardrail_block": "🛑", "decision": "⚖️ ", "retry": "🔁", "failover": "🔀", "error": "❌",
}


def make_emit():
    def emit(etype: str, summary: str, data: dict) -> None:
        print(f"  {ICONS.get(etype, '•')} [{etype}] {summary}")
    return emit


async def one_turn(message: str, history: list) -> list:
    result = await run_agent("cli", message, history, make_emit())
    print(f"\n💬 Agent: {result['reply']}\n   → decision={result['decision']} refund={result['refund']}\n")
    return result["messages"]


async def main() -> None:
    history: list = []
    if len(sys.argv) > 1:
        await one_turn(" ".join(sys.argv[1:]), history)
        return
    print("Refund agent REPL. Type a message (or 'quit').")
    while True:
        try:
            msg = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if msg.lower() in {"quit", "exit"}:
            break
        if msg:
            history = await one_turn(msg, history)


if __name__ == "__main__":
    asyncio.run(main())
