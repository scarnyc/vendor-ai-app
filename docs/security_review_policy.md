# Security Review Policy

## When Security review is required

Security review is required when a vendor will access, process, store, or transmit any of the following:

- Customer personal information
- Employee personal information
- Financial data
- Authentication credentials
- Source code
- Confidential business information
- Production systems
- CRM, HRIS, finance, data warehouse, or identity-management systems
- Usage analytics tied to identifiable users or customers

## Risk tiers

### Low risk

A vendor is generally low risk when it:

- Does not access personal data or confidential business data
- Does not integrate with internal systems
- Does not access production environments
- Has annual contract value below $25,000
- Uses standard commercial terms

### Medium risk

A vendor is generally medium risk when it:

- Processes business contact information
- Integrates with common business systems such as CRM or collaboration tools
- Stores internal operational data
- Provides a current SOC 2 Type II report or equivalent
- Uses subprocessors only in approved regions

### High risk

A vendor is high risk when it:

- Processes customer PII or employee sensitive data
- Integrates with HRIS, finance, production, data warehouse, or identity systems
- Uses AI or machine learning on company, customer, or employee data
- Has subprocessors outside the United States without prior review
- Cannot provide a current SOC 2 Type II report or equivalent
- Provides incomplete or inconsistent security answers
- Requires administrative access to company systems

## Required security materials

Medium-risk and high-risk vendors must provide:

- Completed security questionnaire
- Current SOC 2 Type II report or equivalent
- Data processing agreement when personal data is processed
- Subprocessor list when personal data or confidential data is processed
- Incident response and breach notification summary
- Data retention and deletion description

## Blocking issues

A vendor cannot be recommended as ready for approval if:

- The security questionnaire is missing or materially incomplete
- The vendor processes restricted data and cannot explain retention or deletion
- The vendor uses company, customer, or employee data for model training without explicit approval
