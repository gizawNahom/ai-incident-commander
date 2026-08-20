Feature: Human-approved incident mitigation
  The investigator can recommend a mitigation, but an engineer must explicitly
  approve it before the simulated system changes.

  Scenario Outline: An engineer approves a proposed deployment rollback
    Given a deployment incident has a proposed rollback for "<service>" from "<bad-version>" to "<stable-version>"
    When Engineer (demo) approves the rollback
    Then "<service>" is rolled back to version "<stable-version>"
    And the rollback is completed and audited for "<service>"

    Examples:
      | service         | bad-version | stable-version |
      | payment-service | v1.8.3      | v1.8.2         |

  Scenario: An engineer rejects a proposed deployment rollback
    Given a deployment incident has a proposed rollback for "payment-service" from "v1.8.3" to "v1.8.2"
    When Engineer (demo) rejects the rollback because "Investigating Redis first"
    Then "payment-service" remains on version "v1.8.3"
    And the rejected rollback is audited with reason "Investigating Redis first"

  Scenario: A proposed rollback cannot be executed directly
    Given a deployment incident has a proposed rollback for "payment-service" from "v1.8.3" to "v1.8.2"
    When a caller attempts to execute the proposed rollback directly
    Then the attempted rollback is rejected
    And "payment-service" remains on version "v1.8.3"

  Scenario: A resolved incident cannot accept a rollback approval
    Given a resolved payment incident has a proposed rollback
    When a caller attempts to approve the proposed rollback
    Then the attempted rollback is rejected
    And the rollback remains proposed
