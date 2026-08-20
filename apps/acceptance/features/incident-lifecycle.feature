Feature: Managing a recovered production incident
  Engineers need to preserve evidence while deciding whether a recovered system
  is safe to close.

  Scenario: A defective release creates an investigateable incident
    Given the production system is healthy
    When payment-service version 1.8.3 is released
    Then a checkout degradation incident is opened
    And the incident record contains the release evidence

  Scenario: Sustained recovery moves an incident to monitoring
    Given a payment incident is being investigated
    When the affected payment path remains healthy
    Then the incident is monitoring recovery
    And its incident record retains the earlier failure evidence

  Scenario: An engineer closes a monitored incident
    Given a payment incident is monitoring recovery
    When the engineer resolves the incident
    Then the incident is resolved
    And the audit timeline says the engineer resolved it

  Scenario: A returning failure reopens the existing incident
    Given a payment incident is monitoring recovery
    When the payment path deteriorates again
    Then the existing incident returns to investigation
    And no duplicate payment incident is opened

  Scenario: An unrelated failure opens a separate incident during monitoring
    Given a payment incident is monitoring recovery
    When Kafka processing falls behind
    Then a separate incident is opened for the Kafka delay
    And the payment incident remains monitoring recovery
