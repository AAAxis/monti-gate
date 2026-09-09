// Everything that mutates the workspace's connectors, plus the one thing that
// is not a mutation: keeping the main process's copy current.
//
// That push is the reason this file is a hook rather than three calls in the
// Connectors view. The renderer owns the data and the main process owns the
// outbound request, so a run cannot resolve a connector unless someone has
// handed the list over first -- and that has to happen on load and on every
// edit, not when a dialog happens to be open. See
// electron/automation/connectors.cjs.
import {useCallback, useEffect} from 'react';
import * as db from '../db';
import {native} from '../native';
import {presetFor, runtimeConnector} from '../data/connectors';
import {newId} from './core';
import type {WorkspaceCore} from './core';
import type {ScoutConnector} from '../types';

export type ConnectorActions = ReturnType<typeof useConnectorActions>;

export function useConnectorActions({data}: WorkspaceCore) {
  const {state, withDbError, patch} = data;
  const connectors = state.connectors;

  // Mirrored into the main process whenever the list changes, including the
  // first time it is empty -- clearing matters as much as filling, or a
  // connector deleted here stays runnable until the app restarts.
  //
  // Memory only over there, never written to disk. The dependency is the list
  // itself: useCloudData replaces the array on every load, so this fires on
  // sign-in, on an org switch and on any edit below.
  useEffect(() => {
    void native?.setConnectors?.(connectors.map(runtimeConnector));
  }, [connectors]);

  function blank(kind: string): ScoutConnector {
    const preset = presetFor(kind);
    const category = preset?.category || 'ai';
    return {
      id: newId(),
      name: '',
      category,
      kind,
      config: preset?.suggestedModel ? {model: preset.suggestedModel} : {},
      // The first connector a workspace adds IN THIS CATEGORY is its default.
      // Nothing else would be: a lone connector that is not the default makes
      // every step authored without naming one fail for no reason the user
      // can see. Per category because the unique index is -- an AI step and a
      // notify step each resolve their own default.
      is_default: !connectors.some((item) => item.category === category),
    };
  }

  async function save(connector: ScoutConnector, exists: boolean): Promise<string | null> {
    const error = await withDbError(
        (activeOrgId) => db.connectors.save(activeOrgId, connector, exists));
    if (error) {
      return error;
    }
    patch.connectors((list) => exists ?
      list.map((item) => (item.id === connector.id ? connector : item)) :
      [...list, connector]);
    return null;
  }

  async function remove(id: string): Promise<boolean> {
    const error = await withDbError((activeOrgId) => db.connectors.remove(activeOrgId, [id]));
    if (error) {
      return false;
    }
    patch.connectors((list) => list.filter((item) => item.id !== id));
    return true;
  }

  const setDefault = useCallback(async (id: string): Promise<boolean> => {
    const target = connectors.find((item) => item.id === id);
    if (!target) {
      return false;
    }
    const error = await withDbError(
        (activeOrgId) => db.connectors.setDefault(activeOrgId, target.category, id));
    if (error) {
      return false;
    }
    // Mirrors what the two statements did in the database, in the same order
    // -- and with the same category scope, so promoting a messaging connector
    // leaves the AI default alone.
    patch.connectors((list) => list.map((item) => item.category === target.category ?
      {...item, is_default: item.id === id} :
      item));
    return true;
  }, [connectors, patch, withDbError]);

  return {blank, save, remove, setDefault};
}
