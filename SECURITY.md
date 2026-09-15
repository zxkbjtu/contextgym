# Security Policy

ContextGym processes local coding-agent history and may execute local coding-agent CLIs during A/B evaluation. Treat generated tasks, repositories, and agent actions as code-execution inputs.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's private security reporting feature when available for the repository.

Useful reports include the affected version, operating system, minimal reproduction, expected behavior, and impact. Remove credentials, private prompts, and proprietary repository content.

## Security boundaries

- ContextGym does not require a ContextGym cloud account or telemetry service.
- `sessions parse` omits full conversation text unless explicitly requested.
- Common credential patterns are redacted from stored command reports.
- `optimize` does not directly modify the target repository.
- `apply` requires an eligible result and checks repository HEAD by default.
- A/B evaluation executes the user's installed coding-agent CLI; review the target repository and task before allowing execution.
