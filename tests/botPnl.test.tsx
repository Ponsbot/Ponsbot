import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyPnlFill, initialPnlState, loadPnlState, pnlDisplay, tracedNativeDelta } from "../lib/trading-agents/pnl";
import { BotPnl } from "../components/BotPnl";
vi.stubGlobal("React",React);
const token="0x1111111111111111111111111111111111111111", now=200000000;
describe("realized bot trading P&L",()=>{
  it("replays older accounting once to recover display values without adding old totals twice",()=>{
    expect(loadPnlState(JSON.stringify({cursor:100,lifetimeUsd:999}))).toEqual(initialPnlState());
    const state={...initialPnlState(),cursor:100,lifetimeUsd:12};
    expect(loadPnlState(JSON.stringify(state))).toEqual(state);
  });
  it("does not count buys or unsold appreciation as realized profit",()=>{
    const state=initialPnlState(); applyPnlFill(state,{token,side:"buy",amount:"100",cashUsd:50,at:now-1000});
    expect(pnlDisplay(JSON.stringify(state),now,now)).toMatchObject({dayUsd:0,lifetimeUsd:0});
  });
  it("allocates average purchase cost across partial sales without counting proceeds as profit",()=>{
    const state=initialPnlState();
    applyPnlFill(state,{token,side:"buy",amount:"100",cashUsd:100,at:now-10000});
    applyPnlFill(state,{token:token.toUpperCase(),side:"buy",amount:"100",cashUsd:200,at:now-9000});
    applyPnlFill(state,{token,side:"sell",amount:"50",cashUsd:100,at:now-5000});
    expect(state.lifetimeUsd).toBe(25); expect(state.lots[token]).toEqual({amount:"150",costUsd:225});
    applyPnlFill(state,{token,side:"sell",amount:"150",cashUsd:150,at:now-1000});
    expect(state.lifetimeUsd).toBe(-50); expect(state.lots[token]).toEqual({amount:"0",costUsd:0});
  });
  it("uses a rolling 24 hours, including purchase basis from older trades",()=>{
    const state=initialPnlState();
    applyPnlFill(state,{token,side:"buy",amount:"200",cashUsd:100,at:now-90000000});
    applyPnlFill(state,{token,side:"sell",amount:"100",cashUsd:75,at:now-86400001});
    applyPnlFill(state,{token,side:"sell",amount:"100",cashUsd:80,at:now-1000});
    expect(pnlDisplay(JSON.stringify(state),now,now)).toMatchObject({dayUsd:30,lifetimeUsd:55});
  });
  it("does not treat gifts or unknown purchase costs as free tokens",()=>{
    const state=initialPnlState();
    applyPnlFill(state,{token,side:"sell",amount:"100",cashUsd:500,at:now-86400001});
    expect(pnlDisplay(JSON.stringify(state),now,now)).toMatchObject({dayUsd:0,lifetimeUsd:null});
    applyPnlFill(state,{token,side:"buy",amount:"100",cashUsd:null,at:now-2000});
    applyPnlFill(state,{token,side:"sell",amount:"100",cashUsd:500,at:now-1000});
    expect(pnlDisplay(JSON.stringify(state),now,now)).toMatchObject({dayUsd:null,lifetimeUsd:null});
  });
  it("does not poison later fully known lots after an unknown lot is exhausted",()=>{
    const state=initialPnlState();
    applyPnlFill(state,{token,side:"sell",amount:"10",cashUsd:5,at:now-90000000});
    applyPnlFill(state,{token,side:"buy",amount:"10",cashUsd:5,at:now-2000});
    applyPnlFill(state,{token,side:"sell",amount:"10",cashUsd:8,at:now-1000});
    expect(pnlDisplay(JSON.stringify(state),now,now)).toMatchObject({dayUsd:3,lifetimeUsd:null});
  });
  it("counts actual ETH transfers and refunds, not delegatecall value or reverted subcalls",()=>{
    expect(tracedNativeDelta({type:"CALL",from:token,to:"router",value:"100",calls:[
      {type:"DELEGATECALL",from:token,to:"router",value:"100"},
      {type:"CALL",to:token,value:"20"},
      {type:"CALL",error:"reverted",calls:[{type:"CALL",to:token,value:"900"}]},
    ]},token)).toBe(-80n);
  });
  it("shows both periods with clear signs and never substitutes zero for missing data",()=>{
    const html=renderToStaticMarkup(<BotPnl pnl={{dayUsd:12.345,lifetimeUsd:-5,at:now,pending:false}}/>);
    expect(html).toContain("24h P&amp;L"); expect(html).toContain("Lifetime P&amp;L");
    expect(html).toContain("+$12.35"); expect(html).toContain("-$5.00");
    expect(renderToStaticMarkup(<BotPnl/>)).toContain("Calculating");
    expect(renderToStaticMarkup(<BotPnl pnl={{dayUsd:null,lifetimeUsd:null,at:now,pending:false}}/>)).toContain("Unavailable");
  });
});
