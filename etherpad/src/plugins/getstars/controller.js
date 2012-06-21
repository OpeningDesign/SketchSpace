/**
 * Copyright 2009 RedHog, Egil Möller <egil.moller@piratpartiet.se>
 * Copyright 2010 Pita, Peter Martischka <petermartischka@googlemail.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *      http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import("faststatic");
import("dispatch.{Dispatcher,PrefixMatcher,forward}");

import("etherpad.utils.*");
import("etherpad.collab.server_utils");
import("etherpad.globals.*");
import("etherpad.log");
import("etherpad.pad.padusers");
import("etherpad.pro.pro_utils");
import("etherpad.pro.domains");
import("etherpad.helpers");
import("etherpad.pro.pro_accounts.getSessionProAccount");
import("sqlbase.sqlbase");
import("sqlbase.sqlcommon");
import("sqlbase.sqlobj");
import("etherpad.pad.padutils");
import("etherpad.admin.plugins");
import("etherpad.pad.revisions");
import("etherpad.pad.model");
import("etherpad.collab.server_utils");
import("fastJSON");


function onRequest() {
  var usePadId;
  if (server_utils.isReadOnlyId(request.params.id)) {
    usePadId = server_utils.readonlyToPadId(request.params.id);
    if (!pro_utils.isProDomainRequest()) {
      usePadId = padutils.getGlobalPadId(usePadId);
    }
  } else { 
    usePadId = padutils.getGlobalPadId(request.params.id);
  }
  return model.accessPadGlobal(usePadId, function(pad) {
    response.setContentType("text/plain");
    response.write(fastJSON.stringify({revisions:revisions.getRevisionList(pad), id:request.params.id}));
    return true;
  })
}
