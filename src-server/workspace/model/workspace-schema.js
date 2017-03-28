/* Copyright 2017  Krzysztof Daniel.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/
/*jshint esversion: 6 */

var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var q = require('q');
var ObjectId = mongoose.Types.ObjectId;
/**
 * Workspace, referred also as an organization, is a group of maps that all
 * refer to the same subject, for example to the company. Many people can work
 * on maps within a workspace, and they all have identical access rights.
 */
var workspace = {};

module.exports = function(conn) {
    if (workspace[conn]) {
        return workspace[conn];
    }
    var workspaceSchema = new Schema({
        name : Schema.Types.String,
        purpose : Schema.Types.String,
        description : Schema.Types.String,
        owner : [ {
            type : Schema.Types.String
        } ],
        archived : Schema.Types.Boolean,
        maps : [ {
            type : Schema.Types.ObjectId,
            ref : 'WardleyMap'
        } ],
        capabilityCategories : [ {
          name : Schema.Types.String,
          capabilities : [ {
            aliases: [{
              nodes: [{
                  type: Schema.Types.ObjectId,
                  ref: 'Node'
              }]
            }]
          } ]
        } ]
    });


    workspaceSchema.statics.initWorkspace = function(name, description, purpose, owner) {
        if (!name) {
            name = "Unnamed";
        }
        if (!description) {
            description = "I am too lazy to fill this field even when I know it causes organizational mess";
        }
        if (!purpose) {
            purpose = "Just playing around.";
        }
        var Workspace = require('./workspace-schema')(conn);
        var wkspc = new Workspace({
            name: name,
            description: description,
            purpose: purpose,
            owner: [owner],
            archived: false,
            capabilityCategories : [
              { name:'Customer Service', capabilities : []},
              { name:'Administrative', capabilities : []},
              { name:'Quality', capabilities : []},
              { name:'Operational', capabilities : []},
              { name:'Sales and Marketing', capabilities : []},
              { name:'Research', capabilities : []},
              { name:'Finances', capabilities : []}
            ]
        });
        return wkspc.save();
    };

    workspaceSchema.statics.getAvailableSubmapsForMap = function(mapID, owner, success_callback, accessDenied) {
        var Workspace = require('./workspace-schema')(conn);
        Workspace.findOne({
            owner: owner,
            maps: mapID
        }).exec(function(err, result) {
            if (err) {
                return accessDenied(err);
            }
            if (!result) {
                return accessDenied();
            }
            var WardleyMap = require('./map-schema')(conn);
            // so we have a map that has a workspaceID, now it is time to look for all the maps within the workspace that has submap flag
            // we obviously miss a case where the map is already referenced, but let's leave it for future
            WardleyMap.find({
              workspace : result._id,
              archived: false,
              isSubmap : true
            }).exec(function(err, results){
              if(err){
                return accessDenied(err);
              }
              //handle the results - repack them into something useful.
              // no need to verify access to individual maps as we have confirmed the access to the workspace
              var listOfAvailableSubmaps = [];
              for(var i = 0; i < results.length; i++){
                listOfAvailableSubmaps.push({_id:results[i]._id, name:results[i].name});
              }
              success_callback(listOfAvailableSubmaps);
            });
        });

    };


    workspaceSchema.statics.getSubmapUsage = function(submapID, user, success_callback, accessDenied) {
        var WardleyMap = require('./map-schema')(conn);
        // step one - check access to the submap
        WardleyMap.findOne({
            _id: submapID
        }).exec()
        .then(function(map){
          return map.verifyAccess(user);
        })
        .fail(function(e){
          return accessDenied(e);
        })
        .done(function(map){
          require('./node-schema')(conn).findSubmapUsagesInWorkspace(submapID, map.workspace, success_callback, accessDenied);
        });
    };

    workspaceSchema.methods.createMap = function(editor, user, purpose, responsiblePerson) {
        var WardleyMap = require('./map-schema')(conn);
        var Workspace = require('./workspace-schema')(conn);

        if (!user) {
            user = "your competitor";
        }
        if (!purpose) {
            purpose = "be busy with nothing";
        }
        var newId = new ObjectId();
        this.maps.push(newId);
        return this.save()
            .then(function(workspace) {
                return new WardleyMap({
                    user: user,
                    purpose: purpose,
                    workspace: workspace._id,
                    archived: false,
                    responsiblePerson: responsiblePerson,
                    _id: newId
                }).save();
            });
    };

    workspaceSchema.methods.findUnprocessedNodes = function(){
      var WardleyMap = require('./map-schema')(conn);
      var Node = require('./node-schema')(conn);

      return WardleyMap
          .find({ // find all undeleted maps within workspace
              archived: false,
              workspace: this._id
          })
          .select('user purpose name')
          .then(function(maps) {
              var loadPromises = [];
              maps.forEach(function(cv, i, a) {
                  loadPromises.push(Node
                      .find({
                          parentMap: cv,
                          processedForDuplication: false
                      })
                      .then(function(nodes) {
                          a[i].nodes = nodes;
                          return a[i];
                      }));
              });
              return q.all(loadPromises)
                  .then(function(results) {
                      var finalResults = [];
                      return results.filter(function(map) {
                          return map.nodes && map.nodes.length > 0;
                      });
                  });
          });
    };

    workspaceSchema.methods.findProcessedNodes = function() {
        return this
            .execPopulate({
              path : 'capabilityCategories.capabilities.aliases.nodes',
              model : 'Node'
            });
    };

    workspaceSchema.methods.createNewCapabilityAndAliasForNode = function(categoryID, nodeID) {
        var Node = require('./node-schema')(conn);

        var promises = [];
        var capabilityCategory = null;
        for (var i = 0; i < this.capabilityCategories.length; i++) {
            if (categoryID.equals(this.capabilityCategories[i]._id)) {
                capabilityCategory = this.capabilityCategories[i];
            }
        }
        capabilityCategory.capabilities.push({
            aliases: {
                nodes: [nodeID]
            }
        });
        promises.push(this.save());
        promises.push(Node.update({
            _id: nodeID
        }, {
            processedForDuplication: true
        }, {
            safe: true
        }).exec());
        return q.allSettled(promises).then(function(res) {
            return res[0].value.execPopulate({
                path: 'capabilityCategories',
                populate: {
                    path: 'capabilities',
                    populate: {
                        path: 'aliases',
                        populate: {
                            model: 'Node',
                            path: 'nodes'
                        }
                    }
                }
            });
        });
    };

    workspaceSchema.methods.createNewAliasForNodeInACapability = function(capabilityID, nodeID) {
        var Node = require('./node-schema')(conn);

        var promises = [];
        var capability = null;
        for (var i = 0; i < this.capabilityCategories.length; i++) {
            for (var j = 0; j < this.capabilityCategories[i].capabilities.length; j++) {
                if (capabilityID.equals(this.capabilityCategories[i].capabilities[j]._id)) {
                    capability = this.capabilityCategories[i].capabilities[j];
                }
            }
        }
        capability.aliases.push({
            nodes: [nodeID]
        });
        promises.push(this.save());
        promises.push(Node.update({
            _id: nodeID
        }, {
            processedForDuplication: true
        }, {
            safe: true
        }).exec());
        return q.allSettled(promises).then(function(res) {
            return res[0].value.execPopulate({
                path: 'capabilityCategories',
                populate: {
                    path: 'capabilities',
                    populate: {
                        path: 'aliases',
                        populate: {
                            model: 'Node',
                            path: 'nodes'
                        }
                    }
                }
            });
        });
    };

    workspaceSchema.methods.addNodeToAlias = function(aliasID, nodeID) {
        var Node = require('./node-schema')(conn);

        var promises = [];
        var alias = null;
        for (var i = 0; i < this.capabilityCategories.length; i++) {
          for(var j = 0; j < this.capabilityCategories[i].capabilities.length; j++){
            for(var k = 0; k < this.capabilityCategories[i].capabilities[j].aliases.length; k++){
              if (aliasID.equals(this.capabilityCategories[i].capabilities[j].aliases[k]._id)) {
                  alias = this.capabilityCategories[i].capabilities[j].aliases[k];
              }
            }
          }
        }
        alias.nodes.push(nodeID);
        promises.push(this.save());
        promises.push(Node.update({
            _id: nodeID
        }, {
            processedForDuplication: true
        }, {
            safe: true
        }).exec());
        return q.allSettled(promises).then(function(res) {
            return res[0].value.execPopulate({
                path: 'capabilityCategories',
                populate: {
                    path: 'capabilities',
                    populate: {
                        path: 'aliases',
                        populate: {
                            model: 'Node',
                            path: 'nodes'
                        }
                    }
                }
            });
        });
    };

    workspace[conn] = conn.model('Workspace', workspaceSchema);
    return workspace[conn];
};
