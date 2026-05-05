# Product

> **Customise this file.** This Power ships a placeholder so the
> bundle is structurally complete, but `product.md` is where YOUR
> business domain lives. Strip everything below and replace with
> your project's specifics.

## Domain

This is a Django web application. The product-specific context — what
business problem it solves, who the users are, what features are
in-scope vs out-of-scope — should be filled in here.

## User-facing principles

- Errors visible to end users are written in plain language, not
  framework-speak. "Couldn't save your changes — please try again"
  not "IntegrityError: duplicate key value".
- The admin site is a tool for staff, not a substitute for proper
  customer-facing UI.
- Background work goes through Celery (or your async task queue) —
  request handlers should not block on third-party I/O beyond
  300ms p95.
