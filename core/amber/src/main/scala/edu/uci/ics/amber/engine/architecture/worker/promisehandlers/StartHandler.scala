/*
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

package edu.uci.ics.amber.engine.architecture.worker.promisehandlers

import com.twitter.util.Future
import edu.uci.ics.amber.core.WorkflowRuntimeException
import edu.uci.ics.amber.core.executor.SourceOperatorExecutor
import edu.uci.ics.amber.core.virtualidentity.{ActorVirtualIdentity, ChannelIdentity}
import edu.uci.ics.amber.core.workflow.PortIdentity
import edu.uci.ics.amber.engine.architecture.rpc.controlcommands.{AsyncRPCContext, EmptyRequest}
import edu.uci.ics.amber.engine.architecture.rpc.controlreturns.WorkerStateResponse
import edu.uci.ics.amber.engine.architecture.worker.DataProcessorRPCHandlerInitializer
import edu.uci.ics.amber.engine.architecture.worker.statistics.WorkerState.{READY, RUNNING}

trait StartHandler {
  this: DataProcessorRPCHandlerInitializer =>

  override def startWorker(
      request: EmptyRequest,
      ctx: AsyncRPCContext
  ): Future[WorkerStateResponse] = {
    logger.info("Starting the worker.")
    if (dp.executor.isInstanceOf[SourceOperatorExecutor]) {
      val channelId =
        ChannelIdentity(ActorVirtualIdentity("SOURCE_STARTER"), actorId, isControl = false)
      dp.stateManager.assertState(READY)
      dp.stateManager.transitTo(RUNNING)
      // for source operator: add a virtual input channel just for kicking off the execution
      dp.inputManager.addPort(
        PortIdentity(),
        null,
        urisToRead = List.empty,
        partitionings = List.empty
      )
      dp.inputManager.currentChannelId = channelId
      dp.inputGateway.getChannel(channelId).setPortId(PortIdentity())
      startChannel(request, ctx)
      endChannel(request, ctx)
      WorkerStateResponse(dp.stateManager.getCurrentState)
    } else if (dp.inputManager.getInputPortReaderThreads.nonEmpty) {
      // This means the worker should read from materialized storage for its input ports.
      // Start the reader threads
      dp.inputManager.startInputPortReaderThreads()
      WorkerStateResponse(dp.stateManager.getCurrentState)
    } else {
      throw new WorkflowRuntimeException(
        s"non-source worker $actorId received unexpected StartWorker!"
      )
    }
  }
}
