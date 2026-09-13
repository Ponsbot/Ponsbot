import {expect,it} from "vitest";
import {centralYardActivity} from "../lib/trading-agents/yard-motion";

it("shows telescope activity only when stopped by the left eyepiece",()=>{
  expect(centralYardActivity({x:11,y:32},false)?.key).toBe("lookout");
  expect(centralYardActivity({x:12,y:32},false)?.key).toBe("lookout");
  expect(centralYardActivity({x:11,y:32},true)).toBeUndefined();
});
it.each([{x:27,y:32},{x:23,y:32},{x:18,y:32},{x:13,y:32},{x:11,y:27},{x:11,y:38}])("does not claim telescope use elsewhere %j",point=>{
  expect(centralYardActivity(point,false)?.key).not.toBe("lookout");
});
it("preserves the other central activities",()=>{
  expect(centralYardActivity({x:24,y:70},false)?.key).toBe("garden");
});
