/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Injectable } from "@angular/core";

import * as joint from "jointjs";
import { BehaviorSubject, merge, Observable, Subject } from "rxjs";
import { Workflow, WorkflowContent, WorkflowSettings } from "../../../../common/type/workflow";
import { WorkflowMetadata } from "../../../../dashboard/type/workflow-metadata.interface";
import {
  Comment,
  CommentBox,
  OperatorLink,
  LogicalPort,
  OperatorPredicate,
  Point,
  PortDescription,
} from "../../../types/workflow-common.interface";
import { JointUIService } from "../../joint-ui/joint-ui.service";
import { OperatorMetadataService } from "../../operator-metadata/operator-metadata.service";
import { UndoRedoService } from "../../undo-redo/undo-redo.service";
import { WorkflowUtilService } from "../util/workflow-util.service";
import { JointGraphWrapper } from "./joint-graph-wrapper";
import { SyncTexeraModel } from "./sync-texera-model";
import { WorkflowGraph, WorkflowGraphReadonly } from "./workflow-graph";
import { filter } from "rxjs/operators";
import { isDefined } from "../../../../common/util/predicate";
import { User } from "../../../../common/type/user";
import { SharedModelChangeHandler } from "./shared-model-change-handler";
import { ValidationWorkflowService } from "../../validation/validation-workflow.service";
import { GuiConfigService } from "../../../../common/service/gui-config.service";

export const DEFAULT_WORKFLOW_NAME = "Untitled Workflow";
export const DEFAULT_WORKFLOW = {
  name: DEFAULT_WORKFLOW_NAME,
  description: undefined,
  wid: 0,
  creationTime: undefined,
  lastModifiedTime: undefined,
  isPublished: 0,
  readonly: false,
};

/**
 *
 * WorkflowActionService exposes functions (actions) to modify the workflow graph model of Texera,
 *  such as addOperator, deleteOperator, addLink, deleteLink, etc.
 *
 * WorkflowActionService bundles a series of steps into atomic actions, like adding an operator and its outgoing link.
 *  It also checks the validity of these actions, for example, throws an error if deleting a nonsexist operator.
 *
 * All changes(actions) to the workflow graph should be called through WorkflowActionService,
 *
 * With the introduction of shared editing using yjs, WorkflowActionService will only make changes to its internal
 *  <code>{@link WorkflowGraph}</code>, and <code>{@link SharedModelChangeHandler}</code> will listen to changes to the
 *  WorkflowGraph to update JointGraph.
 *
 * For an overview of the services and updates with shared editing in WorkflowGraphModule, see workflow-graph-design.md.
 *
 */

@Injectable({
  providedIn: "root",
})
export class WorkflowActionService {
  private readonly texeraGraph: WorkflowGraph;
  private readonly jointGraph: joint.dia.Graph;
  private readonly jointGraphWrapper: JointGraphWrapper;
  private readonly syncTexeraModel: SyncTexeraModel;
  private readonly sharedModelChangeHandler: SharedModelChangeHandler;
  // variable to temporarily hold the current workflow to switch view to a particular version
  private tempWorkflow?: Workflow;
  private workflowModificationEnabled = true;
  private enableModificationStream = new BehaviorSubject<boolean>(true);
  private highlightingEnabled = false;
  private centerPoint: Point = { x: 0, y: 0 };

  private workflowMetadata: WorkflowMetadata;
  private workflowMetadataChangeSubject: Subject<WorkflowMetadata> = new Subject<WorkflowMetadata>();
  private resultPanelOpenSubject = new Subject<boolean>();
  public readonly resultPanelOpen$: Observable<boolean> = this.resultPanelOpenSubject.asObservable();

  private workflowSettings: WorkflowSettings;
  private workflowResetSubject = new Subject<void>();

  constructor(
    private operatorMetadataService: OperatorMetadataService,
    private jointUIService: JointUIService,
    private undoRedoService: UndoRedoService,
    private workflowUtilService: WorkflowUtilService,
    private config: GuiConfigService
  ) {
    this.texeraGraph = new WorkflowGraph();
    this.jointGraph = new joint.dia.Graph();
    this.jointGraphWrapper = new JointGraphWrapper(this.jointGraph);

    this.syncTexeraModel = new SyncTexeraModel(this.texeraGraph, this.jointGraphWrapper);
    this.sharedModelChangeHandler = new SharedModelChangeHandler(
      this.texeraGraph,
      this.jointGraph,
      this.jointGraphWrapper,
      this.jointUIService
    );
    this.sharedModelChangeHandler.setConfigService(this.config);
    this.workflowMetadata = DEFAULT_WORKFLOW;
    this.workflowSettings = this.getDefaultSettings();
    this.undoRedoService.setUndoManager(this.texeraGraph.sharedModel.undoManager);

    this.handleJointElementDrag();
  }

  private getDefaultSettings(): WorkflowSettings {
    return {
      dataTransferBatchSize: this.config.env.defaultDataTransferBatchSize,
    };
  }

  /**
   * Workflow modification lock interface (allows or prevents commands that would modify the workflow graph).
   */
  public enableWorkflowModification() {
    if (!this.workflowMetadata.readonly && !this.workflowModificationEnabled) {
      this.workflowModificationEnabled = true;
      this.enableModificationStream.next(true);
      this.undoRedoService.enableWorkFlowModification();
    }
  }

  public disableWorkflowModification() {
    this.workflowModificationEnabled = false;
    this.enableModificationStream.next(false);
    this.undoRedoService.disableWorkFlowModification();
  }

  public checkWorkflowModificationEnabled(): boolean {
    return this.workflowModificationEnabled;
  }

  public getWorkflowModificationEnabledStream(): Observable<boolean> {
    return this.enableModificationStream.asObservable();
  }

  /**
   * Gets joint paper, mainly used for co-editor presence.
   */
  public getJointGraph(): joint.dia.Graph {
    return this.jointGraph;
  }

  /**
   * Gets the read-only version of the TexeraGraph
   *  to access the properties and event streams.
   *
   * Texera Graph contains information about the logical workflow plan of Texera,
   *  such as the types and properties of the operators.
   */
  public getTexeraGraph(): WorkflowGraphReadonly {
    return this.texeraGraph;
  }

  /**
   * Gets the JointGraph Wrapper, which contains
   *  getter for properties and event streams as RxJS Observables.
   *
   * JointJS Graph contains information about the UI,
   *  such as the position of operator elements, and the event of user dragging a cell around.
   */
  public getJointGraphWrapper(): JointGraphWrapper {
    return this.jointGraphWrapper;
  }

  public getCenterPoint(): Point {
    return this.centerPoint;
  }

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  //                                      Below are all the actions available.                                        //
  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  /**
   * Adds an operator to the workflow graph at a point.
   * Throws an Error if the operator ID already existed in the Workflow Graph.
   *
   * @param operator
   * @param point
   */
  public addOperator(operator: OperatorPredicate, point: Point): void {
    // turn off multiselect since there's only one operator added
    this.jointGraphWrapper.setMultiSelectMode(false);
    // check that the operator doesn't exist
    this.texeraGraph.assertOperatorNotExists(operator.operatorID);
    // check that the operator type exists
    if (!this.operatorMetadataService.operatorTypeExists(operator.operatorType)) {
      throw new Error(`operator type ${operator.operatorType} is invalid`);
    }

    this.texeraGraph.bundleActions(() => {
      // add operator to texera graph
      this.texeraGraph.addOperator(operator);
      this.texeraGraph.sharedModel.elementPositionMap?.set(operator.operatorID, point);
    });
  }

  /**
   * Deletes an operator from the workflow graph, also deleting associated links.
   * Throws an Error if the operator ID doesn't exist in the Workflow Graph.
   * @param operatorID
   */
  public deleteOperator(operatorID: string): void {
    this.unhighlightOperators(operatorID);
    this.texeraGraph.bundleActions(() => {
      this.getTexeraGraph()
        .getAllLinks()
        .filter(link => link.source.operatorID === operatorID || link.target.operatorID === operatorID)
        .forEach(link => this.deleteLinkWithID(link.linkID));
      this.texeraGraph.assertOperatorExists(operatorID);
      this.texeraGraph.deleteOperator(operatorID);
      if (this.texeraGraph.sharedModel.elementPositionMap.has(operatorID))
        this.texeraGraph.sharedModel.elementPositionMap.delete(operatorID);
    });
  }

  public addPort(operatorID: string, isInput: boolean, allowMultiInputs?: boolean): void {
    const operator = this.texeraGraph.getOperator(operatorID);
    // TODO: use uniform serde to calculate the portID
    const prefix = isInput ? "input-" : "output-";
    let suffix = isInput ? operator.inputPorts.length : operator.outputPorts.length;
    let portID = prefix + suffix;
    // make sure portID has no conflict
    while (operator.inputPorts.find(p => p.portID === portID) !== undefined) {
      suffix += 1;
      portID = prefix + suffix;
    }

    const port: PortDescription = {
      portID,
      displayName: portID,
      allowMultiInputs,
      isDynamicPort: true,
      dependencies: [],
    };

    if (!operator.dynamicInputPorts && isInput) {
      throw new Error(`operator ${operatorID} does not have dynamic input ports`);
    }
    if (!operator.dynamicOutputPorts && !isInput) {
      throw new Error(`operator ${operatorID} does not have dynamic output ports`);
    }
    if (!isInput && allowMultiInputs !== undefined) {
      throw new Error("error: allowMultiInputs property of an output port should not be specified");
    }

    this.texeraGraph.bundleActions(() => {
      // add port to the operator
      this.texeraGraph.assertOperatorExists(operatorID);
      this.texeraGraph.addPort(operatorID, port, isInput);
    });
  }

  public removePort(operatorID: string, isInput: boolean): void {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.assertOperatorExists(operatorID);
      this.texeraGraph.removePort(operatorID, isInput);
    });
  }

  /**
   * Unhighlight currently selected elements and adds a comment box.
   * @param commentBox
   */
  public addCommentBox(commentBox: CommentBox): void {
    const currentHighlights = this.jointGraphWrapper.getCurrentHighlights();
    this.jointGraphWrapper.unhighlightElements(currentHighlights);
    this.jointGraphWrapper.setMultiSelectMode(false);
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.addCommentBox({ ...commentBox, comments: [] });
      for (const comment of commentBox.comments) {
        this.addComment(comment, commentBox.commentBoxID);
      }
    });
  }

  /**
   * Adds given operators and links to the workflow graph.
   * @param operatorsAndPositions
   * @param links
   * @param commentBoxes
   */
  public addOperatorsAndLinks(
    operatorsAndPositions: readonly { op: OperatorPredicate; pos: Point }[],
    links?: readonly OperatorLink[],
    commentBoxes?: ReadonlyArray<CommentBox>
  ): void {
    // remember currently highlighted operators and groups
    const currentHighlights = this.jointGraphWrapper.getCurrentHighlights();
    // unhighlight previous highlights
    this.jointGraphWrapper.unhighlightElements(currentHighlights);
    this.jointGraphWrapper.setMultiSelectMode(operatorsAndPositions.length > 1);
    this.texeraGraph.bundleActions(() => {
      for (const operatorsAndPosition of operatorsAndPositions) {
        this.addOperator(operatorsAndPosition.op, operatorsAndPosition.pos);
      }
      if (links) {
        for (let i = 0; i < links.length; i++) {
          this.addLink(links[i]);
        }
      }
      if (isDefined(commentBoxes)) {
        commentBoxes.forEach(commentBox => this.addCommentBox(commentBox));
      }
    });
  }

  /**
   * Deletes a comment box.
   * @param commentBoxID
   */
  public deleteCommentBox(commentBoxID: string): void {
    this.texeraGraph.assertCommentBoxExists(commentBoxID);
    this.texeraGraph.deleteCommentBox(commentBoxID);
  }

  /**
   * Deletes given operators and links from the workflow graph.
   * @param operatorIDs
   */
  public deleteOperatorsAndLinks(operatorIDs: readonly string[]): void {
    const operatorIDsCopy = Array.from(new Set(operatorIDs));
    this.texeraGraph.bundleActions(() => {
      // delete links related to the deleted operator
      this.getTexeraGraph()
        .getAllLinks()
        .filter(
          link => operatorIDsCopy.includes(link.source.operatorID) || operatorIDsCopy.includes(link.target.operatorID)
        )
        .forEach(link => this.deleteLinkWithID(link.linkID));
      operatorIDsCopy.forEach(operatorID => {
        this.deleteOperator(operatorID);
      });
    });
  }

  /**
   * Handles the auto layout function
   *
   */
  // Originally: drag Operator
  public autoLayoutWorkflow(): void {
    // This also changes element positions, but we handle this separately.
    this.texeraGraph.bundleActions(() => {
      this.undoRedoService.setListenJointCommand(false);
      this.jointGraphWrapper.autoLayoutJoint();
      for (const operator of this.texeraGraph.getAllOperators()) {
        const operatorID = operator.operatorID;
        const newPosition = this.jointGraphWrapper.getElementPosition(operatorID);
        if (this.texeraGraph.sharedModel.elementPositionMap.get(operatorID) !== newPosition) {
          this.texeraGraph.sharedModel.elementPositionMap.set(operatorID, newPosition);
        }
      }
      for (const commentBox of this.texeraGraph.getAllCommentBoxes()) {
        const commentBoxID = commentBox.commentBoxID;
        const newPosition = this.jointGraphWrapper.getElementPosition(commentBoxID);
        if (this.texeraGraph.sharedModel.elementPositionMap.get(commentBoxID) !== newPosition) {
          this.texeraGraph.sharedModel.elementPositionMap.set(commentBoxID, newPosition);
        }
      }
      this.undoRedoService.setListenJointCommand(true);
    });
  }

  /**
   * Calculating the top-left (minimum x and y) position of all operators
   */
  public calculateTopLeftOperatorPosition(): void {
    this.texeraGraph.bundleActions(() => {
      this.undoRedoService.setListenJointCommand(false);
      const allOperators = this.getTexeraGraph().getAllOperators();
      if (allOperators.length === 0) return;

      let minX = Infinity;
      let minY = Infinity;

      for (const operator of allOperators) {
        const operatorID = operator.operatorID;
        const position = this.jointGraphWrapper.getElementPosition(operatorID);

        if (position.x < minX) {
          minX = position.x;
        }
        if (position.y < minY) {
          minY = position.y;
        }
      }

      this.centerPoint = { x: minX, y: minY };

      this.undoRedoService.setListenJointCommand(true);
    });
  }

  /**
   * Adds a link to the workflow graph
   * Throws an Error if the link ID or the link with same source and target already exists.
   * @param link
   */
  public addLink(link: OperatorLink): void {
    this.texeraGraph.assertLinkNotExists(link);
    this.texeraGraph.assertLinkIsValid(link);
    this.texeraGraph.addLink(link);
  }

  /**
   * Deletes a link with the linkID from the workflow graph
   * Throws an Error if the linkID doesn't exist in the workflow graph.
   * @param linkID
   */
  public deleteLinkWithID(linkID: string): void {
    this.texeraGraph.assertLinkWithIDExists(linkID);
    this.unhighlightLinks(linkID);
    this.texeraGraph.deleteLinkWithID(linkID);
  }

  /**
   * Deletes a link based on the source and target port.
   * @param source
   * @param target
   */
  public deleteLink(source: LogicalPort, target: LogicalPort): void {
    const link = this.getTexeraGraph().getLink(source, target);
    this.deleteLinkWithID(link.linkID);
  }

  /**
   * Replaces the property object with a new one. This is a coarse-grained method for shared-editing.
   * @param operatorID
   * @param newProperty
   */
  public setOperatorProperty(operatorID: string, newProperty: object): void {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.setOperatorProperty(operatorID, newProperty);
    });
  }

  public setPortProperty(operatorPortID: LogicalPort, newProperty: object) {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.setPortProperty(operatorPortID, newProperty);
    });
  }

  public addComment(comment: Comment, commentBoxID: string): void {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.addCommentToCommentBox(comment, commentBoxID);
    });
  }

  public deleteComment(creatorID: number, creationTime: string, commentBoxID: string): void {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.deleteCommentFromCommentBox(creatorID, creationTime, commentBoxID);
    });
  }

  public editComment(creatorID: number, creationTime: string, commentBoxID: string, newContent: string): void {
    this.texeraGraph.bundleActions(() => {
      this.texeraGraph.editCommentInCommentBox(creatorID, creationTime, commentBoxID, newContent);
    });
  }

  public highlightOperators(multiSelect: boolean, ...ops: string[]): void {
    this.getJointGraphWrapper().setMultiSelectMode(multiSelect);
    this.getJointGraphWrapper().highlightOperators(...ops);
    this.getTexeraGraph().updateSharedModelAwareness(
      "highlighted",
      this.jointGraphWrapper.getCurrentHighlightedOperatorIDs()
    );
  }

  public unhighlightOperators(...ops: string[]): void {
    this.getJointGraphWrapper().unhighlightOperators(...ops);
    this.getTexeraGraph().updateSharedModelAwareness(
      "highlighted",
      this.jointGraphWrapper.getCurrentHighlightedOperatorIDs()
    );
  }

  public highlightLinks(multiSelect: boolean, ...links: string[]): void {
    this.getJointGraphWrapper().setMultiSelectMode(multiSelect);
    this.getJointGraphWrapper().highlightLinks(...links);
  }

  public unhighlightLinks(...links: string[]): void {
    this.getJointGraphWrapper().unhighlightLinks(...links);
  }

  public highlightCommentBoxes(multiSelect: boolean, ...commentBoxIDs: string[]): void {
    this.getJointGraphWrapper().setMultiSelectMode(multiSelect);
    this.getJointGraphWrapper().highlightCommentBoxes(...commentBoxIDs);
  }

  public highlightElements(multiSelect: boolean, ...elementIDs: string[]): void {
    this.getJointGraphWrapper().setMultiSelectMode(multiSelect);
    this.highlightOperators(multiSelect, ...elementIDs.filter(id => this.texeraGraph.hasOperator(id)));
    this.highlightLinks(multiSelect, ...elementIDs.filter(id => this.texeraGraph.hasLinkWithID(id)));
    this.highlightCommentBoxes(multiSelect, ...elementIDs.filter(id => this.texeraGraph.hasCommentBox(id)));
  }

  public highlightPorts(multiSelect: boolean, ...ports: LogicalPort[]): void {
    this.getJointGraphWrapper().setMultiSelectMode(multiSelect);
    this.getJointGraphWrapper().highlightPorts(...ports);
  }

  public unhighlightPorts(...ports: LogicalPort[]): void {
    this.getJointGraphWrapper().unhighlightPorts(...ports);
  }

  public disableOperators(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().disableOperator(op);
      });
    });
  }

  public enableOperators(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().enableOperator(op);
      });
    });
  }

  public markReuseResults(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().markReuseResult(op);
      });
    });
  }

  public removeMarkReuseResults(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().removeMarkReuseResult(op);
      });
    });
  }

  public setViewOperatorResults(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().setViewOperatorResult(op);
      });
    });
  }

  public unsetViewOperatorResults(ops: readonly string[]): void {
    this.texeraGraph.bundleActions(() => {
      ops.forEach(op => {
        this.getTexeraGraph().unsetViewOperatorResult(op);
      });
    });
  }

  public setOperatorVersion(operatorId: string, newVersion: string): void {
    this.getTexeraGraph().changeOperatorVersion(operatorId, newVersion);
  }

  public openResultPanel(): void {
    this.resultPanelOpenSubject.next(true);
  }

  public closeResultPanel(): void {
    this.resultPanelOpenSubject.next(false);
  }

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  //                             Below are workflow-level and metadata-related methods.                               //
  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  /**
   * Refreshes the internal shared model and joins a new shared-editing room.
   *
   * This method also updates the undo manager.
   * @param workflowId optional, but needed if you want to join shared editing.
   * @param user optional, but needed if you want to have user presence.
   */
  public setNewSharedModel(workflowId?: number, user?: User) {
    this.texeraGraph.loadNewYModel(workflowId, user, this.config.env.productionSharedEditingServer);
    this.undoRedoService.setUndoManager(this.texeraGraph.sharedModel.undoManager);
  }

  /**
   * Destroys shared-editing related structures and quits the shared editing session.
   */
  public destroySharedModel(): void {
    this.texeraGraph.destroyYModel();
  }

  /**
   * Reload the given workflow, update workflowMetadata and workflowContent.
   * This method is based on the assumption that this is on a new SharedModel.
   *
   * <b>Warning: this resets the workflow but not the SharedModel, so make sure to quit the shared-editing session
   * (<code>{@link destroySharedModel}</code>) before using this method.</b>
   */
  public reloadWorkflow(
    workflow: Readonly<Workflow> | undefined,
    asyncRendering = this.config.env.asyncRenderingEnabled
  ): void {
    this.jointGraphWrapper.setReloadingWorkflow(true);
    this.jointGraphWrapper.jointGraphContext.withContext({ async: asyncRendering }, () => {
      this.setWorkflowMetadata(workflow);
      // remove the existing operators on the paper currently

      this.deleteOperatorsAndLinks(
        this.getTexeraGraph()
          .getAllOperators()
          .map(op => op.operatorID)
      );

      this.getTexeraGraph()
        .getAllCommentBoxes()
        .forEach(commentBox => this.deleteCommentBox(commentBox.commentBoxID));

      if (workflow === undefined) {
        this.setNewSharedModel();
        return;
      }

      const workflowContent: WorkflowContent = workflow.content;
      this.workflowSettings = workflowContent.settings || this.getDefaultSettings();

      let operatorsAndPositions: { op: OperatorPredicate; pos: Point }[] = [];
      workflowContent.operators.forEach(op => {
        const opPosition = workflowContent.operatorPositions[op.operatorID];
        if (!opPosition) {
          throw new Error(`position error: ${op.operatorID}`);
        }
        operatorsAndPositions.push({ op: op, pos: opPosition });
      });

      const links: OperatorLink[] = workflowContent.links;

      const commentBoxes = workflowContent.commentBoxes;

      operatorsAndPositions = this.updateOperatorVersions(operatorsAndPositions);

      this.addOperatorsAndLinks(operatorsAndPositions, links, commentBoxes);

      // restore the view point
      this.getJointGraphWrapper().restoreDefaultZoomAndOffset();
    });
    this.jointGraphWrapper.setReloadingWorkflow(false);

    // After reloading a workflow, need to clear undo/redo stacks because some of the actions involved in reloading
    // may remain in the undo manager.

    this.undoRedoService.clearUndoStack();
    this.undoRedoService.clearRedoStack();
  }

  public workflowChanged(): Observable<unknown> {
    return merge(
      this.getTexeraGraph().getOperatorAddStream(),
      this.getTexeraGraph().getOperatorDeleteStream(),
      this.getTexeraGraph().getLinkAddStream(),
      this.getTexeraGraph().getLinkDeleteStream(),
      this.getTexeraGraph().getPortAddedOrDeletedStream(),
      this.getTexeraGraph().getOperatorPropertyChangeStream(),
      this.getTexeraGraph().getBreakpointChangeStream(),
      this.getJointGraphWrapper().getElementPositionChangeEvent(),
      this.getTexeraGraph().getDisabledOperatorsChangedStream(),
      this.getTexeraGraph().getCommentBoxAddStream(),
      this.getTexeraGraph().getCommentBoxDeleteStream(),
      this.getTexeraGraph().getCommentBoxAddCommentStream(),
      this.getTexeraGraph().getCommentBoxDeleteCommentStream(),
      this.getTexeraGraph().getCommentBoxEditCommentStream(),
      this.getTexeraGraph().getViewResultOperatorsChangedStream(),
      this.getTexeraGraph().getReuseCacheOperatorsChangedStream(),
      this.getTexeraGraph().getOperatorDisplayNameChangedStream(),
      this.getTexeraGraph().getOperatorVersionChangedStream(),
      this.getTexeraGraph().getPortDisplayNameChangedSubject(),
      this.getTexeraGraph().getPortPropertyChangedStream(),
      this.workflowResetSubject.asObservable()
    );
  }

  public workflowMetaDataChanged(): Observable<WorkflowMetadata> {
    return this.workflowMetadataChangeSubject.asObservable();
  }

  /**
   * This is not included in shared editing.
   * @param workflowMetaData
   */
  public setWorkflowMetadata(workflowMetaData: WorkflowMetadata | undefined): void {
    if (this.workflowMetadata === workflowMetaData) {
      return;
    }

    const newMetadata = workflowMetaData === undefined ? DEFAULT_WORKFLOW : workflowMetaData;
    this.workflowMetadata = newMetadata;
    this.workflowMetadataChangeSubject.next(newMetadata);
  }

  public setWorkflowSettings(workflowSettings: WorkflowSettings | undefined): void {
    if (this.workflowSettings === workflowSettings) {
      return;
    }

    const newSettings = workflowSettings === undefined ? this.getDefaultSettings() : workflowSettings;
    this.workflowSettings = newSettings;
  }

  public getWorkflowSettings(): WorkflowSettings {
    return this.workflowSettings;
  }

  public getWorkflowMetadata(): WorkflowMetadata {
    return this.workflowMetadata;
  }

  public getWorkflowContent(): WorkflowContent {
    // collect workflow content
    const texeraGraph = this.getTexeraGraph();
    const operators = texeraGraph.getAllOperators();
    const links = texeraGraph.getAllLinks();
    const operatorPositions: { [key: string]: Point } = {};
    const commentBoxes = texeraGraph.getAllCommentBoxes();
    const settings = this.workflowSettings;

    texeraGraph
      .getAllOperators()
      .forEach(
        op =>
          (operatorPositions[op.operatorID] = this.texeraGraph.sharedModel.elementPositionMap?.get(
            op.operatorID
          ) as Point)
      );
    return {
      operators,
      operatorPositions,
      links,
      commentBoxes,
      settings,
    };
  }

  public getWorkflow(): Workflow {
    return {
      ...this.workflowMetadata,
      ...{ content: this.getWorkflowContent() },
    };
  }

  /**
   * Used for previewing a version. Will clean-up shared editing session before doing so.
   * @param workflow
   */
  public setTempWorkflow(workflow: Workflow): void {
    if (this.texeraGraph.sharedModel.wsProvider.shouldConnect) {
      this.texeraGraph.sharedModel.wsProvider.disconnect();
    }
    this.tempWorkflow = workflow;
  }

  /**
   * Used for ending version preview. Will re-connect to shared editing session after doing so.
   */
  public resetTempWorkflow(): void {
    this.tempWorkflow = undefined;
    this.texeraGraph.sharedModel.wsProvider.connect();
  }

  public getTempWorkflow(): Workflow | undefined {
    return this.tempWorkflow;
  }

  /**
   * This is not included in shared editing.
   * @param name
   */
  public setWorkflowName(name: string): void {
    const newName = name.trim().length > 0 ? name : DEFAULT_WORKFLOW_NAME;
    this.setWorkflowMetadata({ ...this.workflowMetadata, name: newName });
  }

  public setWorkflowDataTransferBatchSize(size: number): void {
    if (size > 0 && size != null) {
      this.setWorkflowSettings({ ...this.workflowSettings, dataTransferBatchSize: size });
    }
  }

  public clearWorkflow(): void {
    this.destroySharedModel();
    this.setWorkflowMetadata(undefined);
    this.setWorkflowSettings(undefined);
    this.reloadWorkflow(undefined);
    this.setHighlightingEnabled(false);
  }

  public setWorkflowIsPublished(newPublishState: number): void {
    this.setWorkflowMetadata({ ...this.workflowMetadata, isPublished: newPublishState });
  }

  /**
   * Need to quit shared-editing room at first.
   */
  public resetAsNewWorkflow() {
    this.destroySharedModel();
    this.reloadWorkflow(undefined);
    this.workflowResetSubject.next();
  }

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  //                                          Below are private methods.                                              //
  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  /**
   * Subscribes to element position changes from joint graph and updates them in TexeraGraph.
   *
   * Also subscribes to element position change event stream,
   *  checks if the element (operator) is moved by user and
   *  if the moved element is currently highlighted,
   *  if it is, moves other highlighted elements (operators) along with it,
   *    links will automatically move with operators.
   *
   *  The subscriptions need and only need to be initiated once,
   *    unlike observers in <code>{@link SharedModelChangeHandler}</code>.
   * @private
   */
  private handleJointElementDrag(): void {
    this.jointGraphWrapper
      .getElementPositionChangeEvent()
      .pipe(
        filter(() => this.jointGraphWrapper.getListenPositionChange()),
        filter(() => this.undoRedoService.listenJointCommand),
        filter(() => this.texeraGraph.getSyncTexeraGraph()),
        filter(movedElement =>
          this.jointGraphWrapper
            .getCurrentHighlightedOperatorIDs()
            .concat(this.jointGraphWrapper.getCurrentHighlightedCommentBoxIDs())
            .includes(movedElement.elementID)
        )
      )
      .subscribe(movedElement => {
        this.texeraGraph.bundleActions(() => {
          if (
            this.texeraGraph.sharedModel.elementPositionMap.get(movedElement.elementID) !== movedElement.newPosition
          ) {
            // For syncing ops/comment boxes in shared editing
            this.texeraGraph.sharedModel.elementPositionMap.set(movedElement.elementID, movedElement.newPosition);
            // For moving all highlighted operators
            const selectedElements = this.jointGraphWrapper
              .getCurrentHighlightedOperatorIDs()
              .concat(this.jointGraphWrapper.getCurrentHighlightedCommentBoxIDs());
            const offsetX = movedElement.newPosition.x - movedElement.oldPosition.x;
            const offsetY = movedElement.newPosition.y - movedElement.oldPosition.y;
            this.jointGraphWrapper.setListenPositionChange(false);
            this.undoRedoService.setListenJointCommand(false);
            // Persistence and shared-editing syncing for comment boxes have different interfaces.
            // Setting positions inside commentBoxes here only for persistence.
            // Syncing uses elementPositionMap.
            selectedElements
              .filter(elementID => elementID.includes("commentBox"))
              .forEach(elementID => {
                this.texeraGraph.sharedModel.commentBoxMap
                  .get(elementID)
                  ?.set("commentBoxPosition", this.jointGraphWrapper.getElementPosition(elementID));
              });
            // Move other highlighted operators.
            selectedElements
              .filter(elementID => elementID !== movedElement.elementID)
              .forEach(elementID => {
                this.jointGraphWrapper.setElementPosition(elementID, offsetX, offsetY);
                this.texeraGraph.sharedModel.elementPositionMap.set(
                  elementID,
                  this.jointGraphWrapper.getElementPosition(elementID)
                );
              });
            this.jointGraphWrapper.setListenPositionChange(true);
            this.undoRedoService.setListenJointCommand(true);
          }
        });
      });
  }

  private updateOperatorVersions(operatorsAndPositions: { op: OperatorPredicate; pos: Point }[]) {
    const updatedOperators: { op: OperatorPredicate; pos: Point }[] = [];
    for (const operatorsAndPosition of operatorsAndPositions) {
      updatedOperators.push({
        op: this.workflowUtilService.updateOperatorVersion(operatorsAndPosition.op),
        pos: operatorsAndPosition.pos,
      });
    }
    return updatedOperators;
  }

  public setHighlightingEnabled(enabled: boolean): void {
    this.highlightingEnabled = enabled;
  }

  public getHighlightingEnabled() {
    return this.highlightingEnabled;
  }
}
