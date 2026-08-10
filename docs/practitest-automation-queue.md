# PractiTest as an Automation Execution Queue

> This is the source design doc behind the queue-based demo mode in this repo
> (`npm run queue:run`, see `scripts/queueRunner.ts` and the README's
> "Queue-based demo (pull model)" section). The implementation here is a
> demo-scoped subset of the full model described below — see the README for
> what's simplified.

## **Objective**

Enable testers and managers to define test sets in PractiTest and have an external automation framework execute those tests automatically, without further human intervention.

---

### **High-Level Concept**

PractiTest serves as the orchestration and control layer, while the automation framework is responsible for:

* Detecting which test sets should be executed  
* Mapping PractiTest tests to automation scripts  
* Executing the automated tests  
* Reporting results and artifacts back into PractiTest

This approach allows PractiTest to remain the single source of truth for planning, execution visibility, traceability, and reporting, while the automation framework remains responsible for test execution.

---

### **Preconditions**

Before automation can run:

* Tests must already be automated.  
* Each PractiTest test must be mapped to a corresponding automation script or automation identifier.  
* Test sets must contain only tests intended for automated execution.  
* The automation framework must be configured to communicate with the PractiTest API.

---

### **Test Set Configuration**

Each test set includes the following custom fields:

#### Automation Requested

A checkbox used to indicate that a test set should be executed automatically.

* Checked \= queued for automation  
* Unchecked \= not eligible for automatic execution

#### Automation Status

A status field used to track the execution lifecycle.  
Suggested values:

* Queued  
* Claimed  
* Running  
* Completed  
* Failed

These fields can be used to create filters and dashboards that provide visibility into the automation pipeline.  
---

### **Execution Flow**

#### **1\. Creating the Test Set**

A tester or manager:

* Creates a test set  
* Adds the relevant automated tests  
* Checks the “Automation Requested” field

The test set now becomes visible to the automation framework through a predefined PractiTest filter representing the automation queue.

---

#### **2\. Detecting Test Sets to Run**

The automation framework:

* Polls PractiTest at a defined interval  
* Retrieves all test sets matching the automation queue filter  
* Selects the next queued test set  
* Updates the test set status to Claimed or Running

This prevents multiple automation workers from processing the same test set simultaneously.

---

#### 3\. Retrieving Test Instances

For the selected test set:

* Test instances are retrieved through the PractiTest API  
* Automation mappings are validated  
* The framework determines which automation script corresponds to each test

If required mappings are missing, the framework can stop execution and update the test set status accordingly.

---

#### 4\. Executing the Tests

The automation framework executes the tests:

* Sequentially or in parallel  
* Based on framework capabilities  
* Based on execution settings defined by the team

PractiTest remains the orchestration layer while the external framework performs the actual execution.

---

#### 5\. Reporting Results

As each test completes, the automation framework reports results back to PractiTest.

Reported information may include:

* Execution status  
* Duration  
* Error messages  
* Screenshots  
* Logs  
* Videos  
* Test reports  
* Additional artifacts

This preserves complete traceability between:

* Test definition  
* Test execution  
* Test results  
* Evidence

---

#### 6\. Completing the Test Set

Once all tests have been processed:

* The framework updates the Automation Status field to Completed or Failed  
* Relevant execution artifacts remain linked to the execution records  
* The test set remains available for reporting, auditing, and analysis

---

#### 7\. Continuous Processing

After completing a test set:

* The automation framework queries PractiTest again  
* If additional test sets are queued, execution continues  
* If no test sets are available, the framework waits until the next polling cycle

---

### Recommended Automation Mapping Strategy

Each automated test should contain a stable automation identifier.  
Examples:

* Script path  
* Test key  
* Automation ID  
* Framework-specific identifier

Using stable identifiers is recommended over matching by test name, as names may change over time.

---

## **Key Benefits**

* No manual triggering   
  Users define what should run directly from PractiTest.

* PractiTest remains the single source of truth  
  Planning, execution visibility, reporting, and traceability stay centralized.

* Clear Execution Visibility  
  Automation status fields provide visibility into queued, running, completed, and failed executions.

* Full Traceability  
  Results, evidence, and execution history remain connected to the original test assets.

* Framework-agnostic  
  The approach works with any automation framework capable of interacting with the PractiTest API.
