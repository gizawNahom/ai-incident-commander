@shared
Feature: Engineer responds to a defective deployment
  Engineers need to investigate a release incident, approve a proposed
  mitigation, and retain a reviewable record of the response.

  Scenario: Engineer investigates, mitigates, and reviews a payment release incident
    Given the engineer opens a healthy Command Center
    Then the Command Center explains how to start a safe incident scenario
    When the engineer deploys the defective payment version
    Then a checkout degradation incident appears in the overview

    When the engineer opens Payment Service from the Services inventory
    Then they see critical live service health, alert evidence, logs, dependencies, and a related incident

    When the engineer opens the related Incident Room
    And asks the AI Investigator to analyze the incident
    Then the investigator presents grounded deployment evidence
    And proposes a rollback without changing the system

    When the engineer takes incident command
    Then the incident records the engineer as commander

    When the incident commander approves the rollback
    Then Payment Service returns to its stable version
    And the incident enters recovery monitoring

    When the incident commander resolves the monitored incident
    And opens Incident History
    Then the resolved incident is listed

    When the engineer reopens the resolved Incident Room
    Then the original deployment, metric spike, logs, mitigation, and resolution remain visible
