/**
 * CDSS Rule Engine for Type 1 Diabetes Triage
 * Rules:
 * - HIGH RISK: RBS >= 11.1 mmol/L AND at least 1 cardinal symptom
 * - MEDIUM RISK: RBS >= 7.0 mmol/L OR at least 1 cardinal symptom
 * - LOW RISK: RBS < 7.0 mmol/L AND no cardinal symptoms
 */

function evaluateRisk(rbsValue, polyuria, polydipsia, weightLoss) {
  const rbs = parseFloat(rbsValue);
  const hasSymptoms = Boolean(polyuria || polydipsia || weightLoss);

  if (rbs >= 11.1 && hasSymptoms) {
    return {
      riskLevel: 'HIGH RISK',
      requiresReferral: true,
      actionNote: 'Immediate facility referral required. Priority intake.'
    };
  } else if (rbs >= 7.0 || hasSymptoms) {
    return {
      riskLevel: 'MEDIUM RISK',
      requiresReferral: false,
      actionNote: 'Schedule follow-up evaluation within 14 days.'
    };
  } else {
    return {
      riskLevel: 'LOW RISK',
      requiresReferral: false,
      actionNote: 'Provide standard preventative health advice.'
    };
  }
}

module.exports = { evaluateRisk };