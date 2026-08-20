Feature: Service visibility and incident history
  Engineers need to assess the live system and revisit the records of prior
  incidents without confusing current recovery state for past evidence.

  Scenario: Engineer reviews the current condition of every monitored service
    Given the simulated system is healthy
    When the engineer opens the Services screen
    Then they see every monitored service
    And each service shows its current health, latency, error rate, traffic, and active-alert count
    And each service links to its service detail

  Scenario Outline: Engineer investigates a service from the service inventory
    Given the "<service>" service is affected by the "<scenario>" scenario
    When the engineer opens the service detail for "<service>"
    Then they see the current metrics for "<service>"
    And they see recent logs for "<service>"
    And they see the current deployment for "<service>"
    And they see dependencies and dependent services for "<service>"
    And they see active alerts affecting "<service>"
    And they can open related incidents for "<service>"

    Examples:
      | service              | scenario           |
      | payment-service      | bad deployment     |
      | redis                | Redis degradation  |
      | notification-service | Kafka backlog      |
      | inventory-service    | service outage     |

  Scenario: Service detail remains useful after a system recovers
    Given "payment-service" was affected by a bad deployment
    And the system has recovered
    When the engineer opens the service detail for "payment-service"
    Then they see the current healthy service state
    And they can open the related historical incident record

  Scenario: Engineer sees active and resolved incidents separately
    Given one incident is active
    And one earlier incident has been resolved
    When the engineer opens Incident History
    Then they see both incidents
    And each incident shows its identifier, title, severity, status, affected services, and start time
    And the resolved incident also shows its resolution time

  Scenario: Engineer filters incident history by lifecycle status
    Given there is an active incident
    And there is a resolved incident
    When the engineer filters Incident History to "Resolved"
    Then they see the resolved incident
    And they do not see the active incident

  Scenario: Engineer filters incident history by severity
    Given there are incidents of different severities
    When the engineer filters Incident History to "SEV-1"
    Then they see only SEV-1 incidents

  Scenario: Engineer reopens a preserved historical investigation
    Given a "payment-service" deployment incident has been resolved
    When the engineer opens that incident from Incident History
    Then they see its preserved timeline
    And they see the deployment and alert evidence captured during the incident
    And they see the incident-scoped metrics and logs
    And they see the final mitigation and resolution events

  Scenario: Empty incident history is intentional
    Given no incidents have been created
    When the engineer opens Incident History
    Then they see an explanation that no incidents have been recorded
    And they see a link to the simulator controls
