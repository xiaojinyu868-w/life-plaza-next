/* Local, embedded character assets. Generation and credentials never run in the browser. */
(function (G) {
  'use strict';
  function create(world, renderer, catalog = G.CDG_CHARACTER_ASSETS) {
    const records = catalog?.characters || [];
    const dragon = world.dragon, placeholder = [...dragon.root.children];
    const original = { body: dragon.body, head: dragon.head, tail: dragon.tail };
    let current = null, request = null, serial = 0;
    const state = { active: null, loading: null, error: null, stats: null, generated: false };
    function dispose(value) { if (!value) return; dragon.root.remove(value.body); value.model.dispose(renderer); }
    async function select(id) {
      const asset = records.find(r => r.id === id);
      if (!asset) throw new Error('character_unavailable');
      if (state.active === id) { serial++; request?.abort(); state.loading=null; state.error=null; return state; }
      request?.abort(); const controller = request = new AbortController(), epoch = ++serial;
      state.loading = id; state.error = null;
      let model;
      try {
        const raw = atob(asset.b64), bytes = new Uint8Array(raw.length);
        for (let i=0; i<raw.length; i++) bytes[i]=raw.charCodeAt(i);
        model = await G.CDG_MODEL.loadGLB(bytes.buffer, { engine:G.E, signal:controller.signal });
        if (epoch !== serial) { model.dispose(renderer); return state; }
        // Upload while the old character is still intact. Device limits must fail
        // here, not during the next classroom frame after the old model is gone.
        renderer.prepareModel(model);
        const body = new G.E.Node({name:asset.name});
        const visual = G.CDG_MODEL.normalize(model,{engine:G.E,height:asset.height});
        visual.rot[1]=asset.rotationY || 0; body.add(visual);
        const old=current; dragon.root.add(body);
        // These inputs are static reference poses. Never pretend they carry a skeletal rig.
        dragon.body=body; dragon.head=new G.E.Node(); dragon.tail=new G.E.Node();
        dragon.height=asset.height; dragon.generated=true;
        for (const node of placeholder) node.visible=false;
        current={body,model}; dispose(old);
        Object.assign(state,{active:id,loading:null,error:null,stats:model.stats,generated:true});
        return state;
      } catch (error) {
        if (epoch !== serial) return state;
        model?.dispose(renderer); state.loading=null;state.error=error.code || error.message || 'character_load_failed';
        throw error;
      }
    }
    function close() {
      serial++;request?.abort();dispose(current);current=null;
      for (const node of placeholder) node.visible=true;
      Object.assign(dragon,original,{height:1.35,generated:false});
      Object.assign(state,{active:null,loading:null,error:null,stats:null,generated:false});
    }
    return { select, close, state, options:records.map(({id,name})=>({id,name})), defaultId:catalog?.default };
  }
  G.CDG_CHARACTERS={create};
  if (typeof module !== 'undefined') module.exports=G.CDG_CHARACTERS;
})(typeof window !== 'undefined' ? window : globalThis);
