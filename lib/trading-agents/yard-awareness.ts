import { yardObstacles } from './yard-navigation';
import { yardZones, zoneObjects, type YardZone } from './yard-zones';

/** Server-owned feet position, using the same footprints as yard navigation. */
export function yardAwareness(position: {zone?:YardZone;x:number;y:number;at:number}|undefined, now:number) {
  if(!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || position.x<0 || position.x>100 || position.y<0 || position.y>100
    || !Number.isFinite(position.at) || position.at>now || now-position.at>120000) return {};
  const zone=position.zone??'center';
  const objects=zone==='center'?yardObstacles.map((o,i)=>({...o,name:yardZones.center.places[i]}))
    :zoneObjects[zone].map((o,i)=>({name:yardZones[zone].places[i],x1:o.x-(o.kind==='water'?12:8),x2:o.x+(o.kind==='water'?12:8),y1:o.y-(o.kind==='water'?12:5),y2:o.y+2}));
  const nearby=objects.map(o=>{
    const dx=Math.max(o.x1-position.x,0,position.x-o.x2),dy=Math.max(o.y1-position.y,0,position.y-o.y2);
    return {name:o.name,distance:Math.hypot(dx,dy)};
  }).filter(o=>o.distance<=22).sort((a,b)=>a.distance-b.distance).slice(0,3)
    .map(o=>({name:o.name,proximity:o.distance<=5?'beside' as const:'nearby' as const}));
  const vertical=position.y<42?'northern':position.y>66?'southern':'';
  const horizontal=position.x<36?'western':position.x>64?'eastern':'';
  return {position:{x:Math.round(position.x/5)*5,y:Math.round(position.y/5)*5,observedAt:position.at,
    region:vertical&&horizontal?`${vertical} ${horizontal} part`:vertical||horizontal?`${vertical||horizontal} part`:'central part'},nearby};
}
