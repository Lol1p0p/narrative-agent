import { MAX_EXPLODING_DEPTH } from "./constants.js";

export function rollSingleDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

export function rollDice(expression, mode) {
  mode = mode || "normal";
  const match = expression.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) return { expression, total: 0, rolls: [], mode, error: "无法解析骰子表达式" };

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (mode === "advantage" || mode === "disadvantage") {
    const set1 = [];
    const set2 = [];
    for (let i = 0; i < count; i++) {
      set1.push(rollSingleDie(sides));
      set2.push(rollSingleDie(sides));
    }
    const sum1 = set1.reduce((a, b) => a + b, 0);
    const sum2 = set2.reduce((a, b) => a + b, 0);
    const takeHigher = mode === "advantage";
    const chosenSet = takeHigher ? (sum1 >= sum2 ? set1 : set2) : (sum1 <= sum2 ? set1 : set2);
    const chosenSum = takeHigher ? Math.max(sum1, sum2) : Math.min(sum1, sum2);
    const total = chosenSum + modifier;

    return {
      expression, total, rolls: chosenSet, modifier, mode,
      allRolls: [set1, set2],
      allSums: [sum1, sum2],
      chosenIndex: (takeHigher ? (sum1 >= sum2 ? 0 : 1) : (sum1 <= sum2 ? 0 : 1)),
    };
  }

  if (mode === "exploding") {
    const rolls = [];
    const explosions = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      let roll = rollSingleDie(sides);
      rolls.push(roll);
      total += roll;
      let depth = 0;
      while (roll === sides && depth < MAX_EXPLODING_DEPTH) {
        roll = rollSingleDie(sides);
        explosions.push(roll);
        total += roll;
        depth++;
      }
    }
    total += modifier;
    return { expression, total, rolls, modifier, mode, explosions };
  }

  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const roll = rollSingleDie(sides);
    rolls.push(roll);
    total += roll;
  }
  total += modifier;

  return { expression, total, rolls, modifier, mode };
}